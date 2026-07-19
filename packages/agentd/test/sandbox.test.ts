import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addRepository,
  applyMigrations,
  associateRepository,
  claimRunAction,
  completeRunAction,
  createIssue,
  createNodeRepositoryInspector,
  createProject,
  getRun,
  init,
  openDb,
  previewRun,
  resolveRunPermission,
  startRun,
  type ServiceContext
} from "@issue-tracker/core";
import { claudeCodeSandbox, resolvePermissionHookScript } from "../src/adapters/claude-code.js";
import { codexSandbox } from "../src/adapters/codex.js";
import type { ProviderLaunch } from "../src/adapters/contract.js";
import { runProcess } from "../src/adapters/process.js";
import { buildSeatbeltProfile, resolveHookReadPaths, resolveToolchainReadPaths, wrapForSandbox } from "../src/sandbox.js";

const tempDirs: string[] = [];
const seatbeltIntegrationAvailable = canApplySeatbelt();
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("provider Seatbelt sandbox", () => {
  it.skipIf(!seatbeltIntegrationAvailable)(
    "denies an ungated out-of-worktree read through runProcess while allowing worktree IO",
    async () => {
      const root = temporarySeatbeltDirectory();
      const worktree = join(root, "worktree");
      const providerDirectory = join(root, "provider");
      mkdirSync(worktree);
      mkdirSync(providerDirectory);
      const secret = join(root, "host-secret");
      const provider = join(providerDirectory, "provider.sh");
      writeFileSync(secret, "fictional-secret");
      writeFileSync(
        provider,
        `#!/bin/sh\ncat ${JSON.stringify(secret)}\nprintf safe > allowed.txt\ncat allowed.txt\n`,
        { mode: 0o755 }
      );

      const result = await runProcess(provider, [], {
        cwd: worktree,
        sandbox: { worktree, executable: provider, hook: null }
      });

      expect(result.stdout, result.stderr).toBe("safe");
      expect(result.stderr).toMatch(/denied|not permitted|operation not permitted/i);
      expect(readFileSync(join(worktree, "allowed.txt"), "utf8")).toBe("safe");
      expect(result.stdout).not.toContain("fictional-secret");
    }
  );

  it.skipIf(!seatbeltIntegrationAvailable)(
    "runs the real permission hook with DB access without exposing another host file",
    async () => {
      const fixture = setupHookFixture(temporarySeatbeltDirectory);
      try {
        const hookScriptPath = resolvePermissionHookScript();
        const input = JSON.stringify({
          session_id: "session-fictional",
          tool_name: "Write",
          tool_use_id: "tool-fictional",
          cwd: fixture.worktree,
          tool_input: { file_path: join(fixture.worktree, "GREETING.md"), content: "hi" }
        });
        const approval = setInterval(() => {
          const pending = getRun(fixture.context, fixture.runId).inputRequests.find(
            (candidate) => candidate.state === "pending"
          );
          if (pending)
            resolveRunPermission(fixture.context, {
              run: fixture.runId,
              request: pending.id,
              decision: "approved"
            });
        }, 20);
        let result;
        try {
          result = await runProcess(process.execPath, [hookScriptPath], {
            cwd: fixture.worktree,
            stdin: input,
            env: {
              ...process.env,
              ISSUE_TRACKER_DB: fixture.dbPath,
              ISSUE_TRACKER_RUN_ID: fixture.runId,
              ISSUE_TRACKER_PARTICIPANT_ID: fixture.participantId,
              ISSUE_TRACKER_PERMISSION_POLL_MS: "10"
            },
            sandbox: {
              worktree: fixture.worktree,
              executable: process.execPath,
              hook: { dbPath: fixture.dbPath, hookScriptPath }
            }
          });
        } finally {
          clearInterval(approval);
        }

        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain('"permissionDecision":"allow"');
        expect(getRun(fixture.context, fixture.runId).inputRequests).toHaveLength(1);

        const denied = await runProcess(
          process.execPath,
          [
            "-e",
            `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(fixture.secret)}, "utf8"))`
          ],
          {
            cwd: fixture.worktree,
            sandbox: {
              worktree: fixture.worktree,
              executable: process.execPath,
              hook: { dbPath: fixture.dbPath, hookScriptPath }
            }
          }
        );
        expect(denied.exitCode).not.toBe(0);
        expect(denied.stdout).not.toContain("unrelated-fictional-secret");
      } finally {
        fixture.close();
      }
    }
  );

  it("omits sensitive home paths and includes canonical worktree and hook allowances", () => {
    const root = temporaryExternalDirectory();
    const worktree = join(root, "worktree");
    const control = join(root, "control");
    const installation = join(root, "installation");
    const hook = join(installation, "packages", "agentd", "dist", "permission-hook.js");
    mkdirSync(worktree);
    mkdirSync(control);
    mkdirSync(dirname(hook), { recursive: true });
    mkdirSync(join(installation, "node_modules"));
    writeFileSync(hook, "// fictional hook");
    writeFileSync(join(control, "tracker.db"), "");

    const profile = buildSeatbeltProfile({
      worktree,
      readPaths: resolveToolchainReadPaths(process.execPath),
      writePaths: [],
      hook: { dbPath: join(control, "tracker.db"), hookScriptPath: hook }
    });

    expect(profile).toContain(realpath(worktree));
    expect(profile).toContain(realpath(control));
    expect(profile).toContain(realpath(installation));
    expect(profile).not.toContain(join(homedir(), ".ssh"));
    expect(profile).not.toContain(join(homedir(), ".aws"));
    expect(profile).not.toContain(`(subpath ${JSON.stringify(realpath(homedir()))})`);
  });

  it("allows only the hook package and concrete dependencies in a hoisted workspace", () => {
    const root = temporaryExternalDirectory();
    const installation = join(root, "packages", "agentd");
    const hook = join(installation, "dist", "permission-hook.js");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(join(installation, "package.json"), "{}");
    writeFileSync(hook, "// fictional hook");
    const dependencies = ["@issue-tracker/core", "better-sqlite3", "bindings", "file-uri-to-path", "drizzle-orm", "zod"];
    const entries = new Map<string, string>();
    for (const dependency of dependencies) {
      const entry = join(root, "node_modules", dependency, "index.js");
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, "// fictional dependency");
      writeFileSync(join(dirname(entry), "package.json"), "{}");
      entries.set(dependency, entry);
    }

    const paths = resolveHookReadPaths(hook, (dependency) => entries.get(dependency)!);
    expect(paths).toContain(realpath(installation));
    for (const entry of entries.values()) expect(paths).toContain(realpath(dirname(entry)));
    expect(paths).not.toContain(realpath(root));
  });

  it("returns the provider argv unchanged when Seatbelt is unavailable", () => {
    const wrapped = wrapForSandbox({
      executable: "fictional-provider",
      args: ["--fictional"],
      cwd: process.cwd(),
      sandbox: { worktree: process.cwd(), executable: "fictional-provider", hook: null },
      available: false
    });
    expect(wrapped.executable).toBe("fictional-provider");
    expect(wrapped.args).toEqual(["--fictional"]);
    expect(() => wrapped.cleanup()).not.toThrow();
  });

  // These assertions run on every platform without kernel Seatbelt: they guard the generated
  // profile against the two ways the jail could silently regress to a no-op while the skipped
  // integration tests still pass on CI — the deny-default base being dropped, or the allowlist
  // over-broadening to cover the whole filesystem or an out-of-worktree secret.
  it("denies by default and never widens to allow-default or an out-of-worktree secret", () => {
    const root = temporaryExternalDirectory();
    const worktree = join(root, "worktree");
    const secret = join(root, "host-secret");
    mkdirSync(worktree);
    writeFileSync(secret, "fictional-secret");

    const profile = buildSeatbeltProfile({
      worktree,
      readPaths: resolveToolchainReadPaths(process.execPath),
      writePaths: [],
      hook: null
    });

    expect(profile).toContain("(deny default)");
    expect(profile).not.toContain("(allow default)");
    // A whole-filesystem allowance ("/" as a read/write subpath) would defeat containment.
    expect(profile).not.toMatch(/\(subpath "\/"\)/);
    // The sibling secret is outside the worktree and must never appear in any allowance. (The
    // worktree itself is a child of `root`, so asserting on `root` would falsely match.)
    expect(profile).not.toContain(realpath(secret));
  });

  it("grants the worktree write access and the hook DB directory but not arbitrary siblings", () => {
    const root = temporaryExternalDirectory();
    const worktree = join(root, "worktree");
    const control = join(root, "control");
    const installation = join(root, "installation");
    const hook = join(installation, "packages", "agentd", "dist", "permission-hook.js");
    const sibling = join(root, "sibling-secret");
    mkdirSync(worktree);
    mkdirSync(control);
    mkdirSync(dirname(hook), { recursive: true });
    mkdirSync(join(installation, "node_modules"));
    writeFileSync(hook, "// fictional hook");
    writeFileSync(join(control, "tracker.db"), "");
    writeFileSync(sibling, "sibling-fictional-secret");

    const profile = buildSeatbeltProfile({
      worktree,
      readPaths: [],
      writePaths: [worktree],
      hook: { dbPath: join(control, "tracker.db"), hookScriptPath: hook }
    });

    const writeLine = profile.split("\n").find((line) => line.startsWith("(allow file-read* file-write*")) ?? "";
    expect(writeLine).toContain(realpath(worktree));
    expect(writeLine).toContain(realpath(control));
    expect(profile).not.toContain(realpath(sibling));
  });

  it("wraps the provider argv in sandbox-exec with a generated profile when Seatbelt is available", () => {
    const root = temporaryExternalDirectory();
    const worktree = join(root, "worktree");
    mkdirSync(worktree);
    const wrapped = wrapForSandbox({
      executable: process.execPath,
      args: ["--fictional-flag"],
      cwd: worktree,
      sandbox: { worktree, executable: process.execPath, hook: null },
      available: true
    });
    try {
      expect(wrapped.executable).toBe("/usr/bin/sandbox-exec");
      expect(wrapped.args[0]).toBe("-f");
      const profile = readFileSync(wrapped.args[1], "utf8");
      expect(profile).toContain("(deny default)");
      expect(wrapped.args.slice(2)).toEqual([process.execPath, "--fictional-flag"]);
    } finally {
      wrapped.cleanup();
    }
  });

  // The osSandbox flag is the only thing that turns the jail on; if it stops flowing from the
  // engine definition into the ProviderSandbox descriptor the kernel jail silently never engages
  // and no integration test would fail. These cover that wiring for both adapters directly.
  it("engages the Claude Code jail only when osSandbox is set, threading the hook DB channel", () => {
    process.env.ISSUE_TRACKER_PERMISSION_HOOK_SCRIPT = "/fictional/permission-hook.js";
    try {
      expect(claudeCodeSandbox(launchFixture({ osSandbox: false }))).toBeNull();
      expect(claudeCodeSandbox(launchFixture({}))).toBeNull();

      const withoutHook = claudeCodeSandbox(launchFixture({ osSandbox: true }));
      expect(withoutHook).toEqual({
        worktree: "/fictional/worktree",
        executable: "/fictional/claude",
        hook: null
      });

      const withHook = claudeCodeSandbox(
        launchFixture({ osSandbox: true }, { dbPath: "/fictional/control/tracker.db", runId: "run-fictional" })
      );
      expect(withHook?.hook).toEqual({
        dbPath: "/fictional/control/tracker.db",
        hookScriptPath: "/fictional/permission-hook.js"
      });
    } finally {
      delete process.env.ISSUE_TRACKER_PERMISSION_HOOK_SCRIPT;
    }
  });

  it("never engages the OS jail for Codex, even when osSandbox is set", () => {
    expect(codexSandbox(launchFixture({ osSandbox: true }))).toBeNull();
    expect(codexSandbox(launchFixture({ osSandbox: false }))).toBeNull();
  });
});

function launchFixture(
  options: Record<string, unknown>,
  permissionHook: ProviderLaunch["permissionHook"] = null
): ProviderLaunch {
  return {
    participantId: "participant-fictional",
    role: "planner",
    executable: "/fictional/claude",
    model: "fictional-model",
    workingDirectory: "/fictional/worktree",
    prompt: "fictional prompt",
    options,
    permissionHook
  };
}

function temporaryExternalDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "tracker-seatbelt-test-"));
  tempDirs.push(directory);
  return directory;
}

function temporarySeatbeltDirectory() {
  // The profile permits the process temporary directory. Keep integration secrets outside it so
  // this verifies the jail rather than accidentally allowlisting the fixture through TMPDIR.
  const directory = mkdtempSync("/private/tmp/tracker-seatbelt-test-");
  tempDirs.push(directory);
  return directory;
}

function canApplySeatbelt() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore"
    });
    return true;
  } catch {
    // Nested sandboxes (including the Codex test runner) cannot install another Seatbelt profile.
    return false;
  }
}

function realpath(path: string) {
  return realpathSync(path);
}

function setupHookFixture(createRoot = temporaryExternalDirectory) {
  const root = createRoot();
  const worktree = join(root, "worktree");
  const control = join(root, "control");
  mkdirSync(control);
  execFileSync("git", ["init", "-b", "main", worktree]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Fictional",
    "-c",
    "user.email=fictional@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "Set up fictional repository"
  ]);
  const dbPath = join(control, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date() } };
  const initialized = init(context, { teamKey: "ENG", actorHandle: "owner" });
  context.actor = initialized.actor;
  const project = createProject(context, { name: "Fictional Sandbox" });
  const issue = createIssue(context, {
    title: "Confine fictional provider",
    projectId: project.id
  });
  const command = { executable: process.execPath, args: ["-e", "process.exit(0)"], envNames: [] };
  const repository = addRepository(
    context,
    { name: "Primary", path: worktree, testCommand: command, verificationCommand: command },
    createNodeRepositoryInspector()
  );
  associateRepository(context, {
    repository: repository.id,
    project: project.id,
    position: 0,
    isDefault: true,
    overrideKind: "replace"
  });
  const runtime = { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data") };
  const preview = previewRun(context, { issue: issue.identifier }, runtime);
  const started = startRun(
    context,
    {
      issue: issue.identifier,
      previewFingerprint: preview.previewFingerprint,
      confirmWarnings: preview.warnings
    },
    runtime
  );
  const provision = claimRunAction(context, { supervisorId: "agentd" })!;
  completeRunAction(context, { actionId: provision.id, supervisorId: "agentd", result: {} });
  const participant = getRun(context, started.id).participants.find(
    (candidate) => candidate.role === "planner"
  )!;
  db.$client
    .prepare("update run_participants set state = ?, started_at = ? where id = ?")
    .run("running", context.clock.now().toISOString(), participant.id);
  const secret = join(root, "unrelated-secret");
  writeFileSync(secret, "unrelated-fictional-secret");
  return {
    context,
    runId: started.id,
    participantId: participant.id,
    dbPath,
    worktree,
    secret,
    close: () => db.$client.close()
  };
}
