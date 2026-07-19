/**
 * Defense-in-depth macOS Seatbelt confinement for supervised providers. The durable permission
 * hook remains the policy authority for mutations, but policy code can fail open; this jail is the
 * kernel-enforced boundary that prevents an approved or otherwise ungated read from escaping the
 * worktree and explicit toolchain paths. The tracker DB is deliberately available to a confined
 * hook child as its sanctioned control channel, while host secrets such as ~/.ssh and ~/.aws are
 * never allowlisted.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export interface ProviderSandbox {
  worktree: string;
  executable: string;
  hook?: { dbPath: string; hookScriptPath: string } | null;
}

export function isSeatbeltAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

export function resolveToolchainReadPaths(executable: string): string[] {
  const provider = resolveExecutable(executable);
  const node = realpathSync(process.execPath);
  const git = resolveExecutable("git");
  const home = homedir();
  const candidates = [
    dirname(provider),
    dirname(dirname(node)),
    dirname(git),
    "/usr/lib",
    "/usr/bin",
    "/bin",
    "/System",
    "/private/var/db/dyld",
    "/System/Volumes/Preboot/Cryptexes",
    "/opt/homebrew",
    "/usr/local",
    "/etc/resolv.conf",
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
    join(home, ".npm"),
    join(home, ".cache"),
    join(home, ".config"),
    join(home, ".codex"),
    join(home, "Library", "Keychains"),
    join(home, "Library", "Preferences")
  ];
  const nvmRoot = join(home, ".nvm");
  if (node.startsWith(`${realpathIfPresent(nvmRoot) ?? nvmRoot}/`))
    candidates.push(dirname(dirname(node)));
  return canonicalExisting(candidates);
}

export function buildSeatbeltProfile(input: {
  worktree: string;
  readPaths: string[];
  writePaths: string[];
  hook?: { dbPath: string; hookScriptPath: string } | null;
}): string {
  const readPaths = input.readPaths.map(canonical);
  const writePaths = input.writePaths.map(canonical);
  const worktree = canonical(input.worktree);
  const temporaryDirectory = canonical(process.env.TMPDIR ?? tmpdir());
  if (input.hook) {
    const hookScript = canonical(input.hook.hookScriptPath);
    readPaths.push(findInstallRoot(hookScript));
    writePaths.push(canonical(dirname(input.hook.dbPath)));
  }
  const claudeState = realpathIfPresent(join(homedir(), ".claude"));
  if (claudeState) writePaths.push(claudeState);

  const reads = unique(readPaths).map(subpath).join(" ");
  const writes = unique([worktree, temporaryDirectory, ...writePaths])
    .map(subpath)
    .join(" ");
  return [
    "(version 1)",
    '(import "system.sb")',
    "(deny default)",
    "(allow process-fork process-exec*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow network-outbound)",
    "(allow file-read-metadata)",
    ...(reads ? [`(allow file-read* ${reads})`] : []),
    `(allow file-read* file-write* ${writes})`,
    ""
  ].join("\n");
}

export function wrapForSandbox(input: {
  executable: string;
  args: string[];
  cwd: string;
  sandbox: ProviderSandbox;
  available?: boolean;
}): { executable: string; args: string[]; cleanup: () => void } {
  if (!(input.available ?? isSeatbeltAvailable()))
    return { executable: input.executable, args: input.args, cleanup: () => {} };
  const directory = mkdtempSync(join(tmpdir(), "tracker-seatbelt-"));
  const profilePath = join(directory, "provider.sb");
  const readPaths = resolveToolchainReadPaths(input.sandbox.executable);
  const profile = buildSeatbeltProfile({
    worktree: input.sandbox.worktree,
    readPaths,
    writePaths: [input.cwd],
    hook: input.sandbox.hook
  });
  writeFileSync(profilePath, profile, { mode: 0o600 });
  return {
    executable: "/usr/bin/sandbox-exec",
    args: ["-f", profilePath, input.executable, ...input.args],
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

function resolveExecutable(executable: string) {
  if (executable.includes("/")) return canonical(resolve(executable));
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, executable);
    if (existsSync(candidate)) return canonical(candidate);
  }
  return canonical(executable);
}

function findInstallRoot(hookScriptPath: string) {
  let current = dirname(hookScriptPath);
  while (dirname(current) !== current) {
    if (existsSync(join(current, "node_modules"))) return canonical(current);
    current = dirname(current);
  }
  throw new Error(
    `Could not find an agentd install root containing node_modules above ${hookScriptPath}.`
  );
}

function canonical(path: string) {
  return realpathSync(path);
}

function realpathIfPresent(path: string) {
  return existsSync(path) ? canonical(path) : null;
}

function canonicalExisting(paths: string[]) {
  return unique(paths.flatMap((path) => (existsSync(path) ? [canonical(path)] : [])));
}

function unique(paths: string[]) {
  return [...new Set(paths)];
}

function subpath(path: string) {
  return `(subpath ${JSON.stringify(path)})`;
}
