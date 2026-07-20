import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { expireHookPermissionWait, getRunInputRequest, openDb, recordPermissionAutoApproval, recordPermissionWaitProgress, requestRunInput, systemClock, type ServiceContext } from "@issue-tracker/core";

/**
 * PreToolUse hook invoked by a supervised Claude Code subprocess. Claude Code blocks the tool call
 * while this process runs, which lets the supervisor convert an in-flight permission prompt into a
 * durable `run_input_requests` row and hold the provider until a human answers.
 *
 * The wait is bounded. When it expires the request stays pending but converts to resume delivery,
 * so a later approval reaches the provider by restarting the session instead of by a hook that is
 * no longer listening. See `expireHookPermissionWait`.
 *
 * Every failure path denies. A permission hook that cannot reach its database must not become an
 * approval, so the process fails closed on unreachable state, malformed input, and unexpected errors.
 */
export interface PermissionHookEnvironment {
  ISSUE_TRACKER_DB?: string;
  ISSUE_TRACKER_RUN_ID?: string;
  ISSUE_TRACKER_PARTICIPANT_ID?: string;
  ISSUE_TRACKER_WORKTREE_ROOT?: string;
  ISSUE_TRACKER_PERMISSION_TIMEOUT_MS?: string;
  ISSUE_TRACKER_PERMISSION_POLL_MS?: string;
  ISSUE_TRACKER_PERMISSION_PROGRESS_MS?: string;
}

interface HookPayload {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
  cwd?: unknown;
}

interface CommandRule {
  prefix: string[];
  flags: ReadonlySet<string>;
  valueFlags?: RegExp;
  numericShorthand?: boolean;
}

/**
 * Command prefixes that cannot alter the worktree, the repository, or anything outside them. Each
 * entry has its own allowlist because a flag that is read-only for one program can write or execute
 * for another. Several obvious candidates are absent: `git branch` deletes with -D, `git remote`
 * mutates with `add`, `find` writes with -delete and -exec, `sed` edits in place with -i, `sort`
 * writes with -o, and `file` writes a compiled magic table with -C (a flag benign for `ls`, but
 * dangerous for `file`).
 */
const READ_ONLY_RULES: CommandRule[] = [
  { prefix: ["git", "status"], flags: new Set(["-s", "--short", "-b", "--branch", "--porcelain"]) },
  { prefix: ["git", "log"], flags: new Set(["-p", "--oneline", "--abbrev-commit", "--decorate", "--graph", "--stat", "--numstat", "--name-only", "--name-status", "--color", "--no-color", "--reverse", "--all", "--no-pager"]), valueFlags: /^--(format|pretty|max-count|since|until|author|grep)=/, numericShorthand: true },
  { prefix: ["git", "show"], flags: new Set(["-s", "--stat", "--numstat", "--name-only", "--name-status", "--oneline", "--abbrev-commit", "--color", "--no-color", "--no-pager"]), valueFlags: /^--(format|pretty)=/, numericShorthand: true },
  { prefix: ["git", "diff"], flags: new Set(["-R", "--stat", "--numstat", "--name-only", "--name-status", "--cached", "--staged", "--color", "--no-color", "--word-diff", "--summary"]) },
  { prefix: ["git", "ls-tree"], flags: new Set(["-r", "-l", "--name-only", "--long"]) },
  { prefix: ["git", "ls-files"], flags: new Set(["--cached"]) },
  { prefix: ["git", "rev-parse"], flags: new Set(["--short"]) },
  { prefix: ["git", "cat-file"], flags: new Set(["-p", "-t", "-s", "-e"]) },
  { prefix: ["git", "blame"], flags: new Set(["-l", "-s", "-L"]) },
  { prefix: ["git", "describe"], flags: new Set(["--long", "--all"]) },
  { prefix: ["git", "shortlog"], flags: new Set(["-s", "-n", "-e"]) },
  // `-R` is intentionally absent from ls and grep: operand confinement resolves only the literal
  // operand, but a recursive read (`grep -R . `, `ls -R .`) descends into an in-tree symlink that
  // points outside the worktree and escapes containment (verified: `grep -R` follows it, `grep -r`
  // does not). So recursive-with-symlink-follow flags gate to a human. `-r` stays — it recurses
  // within the worktree without dereferencing symlinks.
  { prefix: ["ls"], flags: new Set(["-a", "-A", "-l", "-L", "-h", "-r", "-t", "-S", "-c", "-u", "-b", "-p", "-q", "-s", "-i", "-la", "-al", "-lh", "-ll", "-lr", "-rl", "--all", "--human-readable", "--long", "--reverse", "--color", "--no-color"]) },
  { prefix: ["pwd"], flags: new Set() },
  { prefix: ["cat"], flags: new Set(["-n", "-b", "-s", "-e", "-v"]) },
  { prefix: ["head"], flags: new Set(["-n", "-c", "-q", "-v"]), numericShorthand: true },
  { prefix: ["tail"], flags: new Set(["-n", "-c", "-q", "-v"]), numericShorthand: true },
  { prefix: ["wc"], flags: new Set(["-l", "-w", "-c", "-m", "-L"]) },
  { prefix: ["od"], flags: new Set(["-c", "-b", "-A", "-t"]) },
  { prefix: ["stat"], flags: new Set(["-L"]) },
  { prefix: ["basename"], flags: new Set() },
  { prefix: ["dirname"], flags: new Set() },
  { prefix: ["echo"], flags: new Set(["-n", "-e", "-E"]) },
  { prefix: ["which"], flags: new Set(["-a"]) },
  { prefix: ["grep"], flags: new Set(["-i", "-n", "-r", "-l", "-L", "-c", "-v", "-w", "-e", "-h", "-q", "-s"]) },
  { prefix: ["rg"], flags: new Set(["-i", "-n", "-l", "-w", "-v", "-c", "-e", "-s", "-S"]) },
  { prefix: ["diff"], flags: new Set(["-u", "-r", "-i", "-w", "-b", "-q", "-c", "-a"]) },
  { prefix: ["true"], flags: new Set() }
];

/**
 * Shell syntax that can chain, substitute, or redirect. Any of these means the command is more than
 * the program its first token names, so prefix matching would no longer describe what runs. Such a
 * command is never auto-approved regardless of how it starts.
 */
const SHELL_CONTROL = /[;&|`$(){}<>\n\r\\!*?[\]]/;

function isSafeFlag(rule: CommandRule, token: string) {
  return (rule.numericShorthand && /^-\d+$/.test(token)) || rule.flags.has(token) || (rule.valueFlags?.test(token) ?? false);
}

/**
 * A plain operand can name a file. Matching the flags alone left the read half of the invariant
 * unenforced: every allowlisted reader (`cat`, `grep -r`, `od`, `stat`, `git show`…) would accept an
 * absolute or parent-relative path and exfiltrate anything the process can read — `cat /etc/passwd`,
 * `cat ~/.ssh/id_ed25519`, `grep -r AKIA /`. So an operand that escapes the worktree is refused: no
 * absolute path, no home-relative path, no `..` traversal. A bare relative operand (a filename, a
 * git rev like `HEAD~1`, a search pattern) resolves inside the worktree and is allowed; shell
 * metacharacters that could smuggle a path out are already rejected before we get here.
 */
function isConfinedOperand(token: string) {
  if (token.startsWith("/") || token.startsWith("~")) return false;
  return !token.split("/").includes("..");
}

function isSafeArgument(rule: CommandRule, token: string) {
  return token.startsWith("-") ? isSafeFlag(rule, token) : isConfinedOperand(token);
}

function parseReadOnlyCommand(command: unknown): { operands: string[] } | null {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL.test(trimmed)) return null;
  // Quoted arguments can hide separators from a naive token split, so only bare tokens qualify.
  if (/["']/.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.some((token) => token === "--")) return null;
  const rule = READ_ONLY_RULES.find((candidate) => candidate.prefix.every((word, index) => tokens[index] === word));
  if (!rule) return null;
  // Every argument past the matched command must be a known-safe flag or a worktree-confined operand.
  const trailing = tokens.slice(rule.prefix.length);
  if (!trailing.every((token) => isSafeArgument(rule, token))) return null;
  return { operands: trailing.filter((token) => !token.startsWith("-")) };
}

export function isReadOnlyCommand(command: unknown): boolean {
  return parseReadOnlyCommand(command) !== null;
}

function isWithin(realRoot: string, candidate: string): boolean {
  const rel = relative(realRoot, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

// Resolve an operand against the base directory, following symlinks on the portion that exists so an
// in-tree link pointing outside the worktree is caught, then re-append the not-yet-created tail. The
// lexical check already rejected absolute/`~`/`..` operands; this closes the symlink escape it can't see.
function resolveWithinBase(base: string, operand: string): string {
  let current = resolve(base, operand);
  const tail: string[] = [];
  while (true) {
    try {
      lstatSync(current);
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) break;
      tail.unshift(basename(current));
      current = parent;
    }
  }
  const real = realpathSync(current);
  return tail.length ? join(real, ...tail) : real;
}

function isConfinedResolved(operand: string, base: string, realRoot: string): boolean {
  try { return isWithin(realRoot, resolveWithinBase(base, operand)); }
  catch { return false; }
}

/** Read-only inspection is auto-approved; everything that can mutate or leave the machine is not. */
export function isAutoApprovable(payload: HookPayload, worktreeRoot?: string): boolean {
  if (payload.tool_name !== "Bash") return false;
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input as Record<string, unknown> : {};
  const parsed = parseReadOnlyCommand(input.command);
  if (!parsed) return false;
  // Read confinement needs a worktree root and an in-worktree cwd. Fail closed when either is missing:
  // without the root there is no boundary, and an out-of-tree cwd would let even an operand-less
  // reader (`ls`, `git log`) disclose state from outside the worktree, so both are required first.
  if (!worktreeRoot) return false;
  let realRoot: string;
  try { realRoot = realpathSync(worktreeRoot); }
  catch { return false; }
  if (typeof payload.cwd !== "string") return false;
  let base: string;
  // Operand confinement resolves against Claude Code's trusted payload cwd; an out-of-tree cwd fails closed via isWithin.
  try { base = realpathSync(payload.cwd); }
  catch { return false; }
  if (!isWithin(realRoot, base)) return false;
  // Operand-bearing readers must additionally keep every path operand inside the worktree; an
  // operand-less reader is already confined by the cwd check above.
  return parsed.operands.every((operand) => isConfinedResolved(operand, base, realRoot));
}

export function decision(permissionDecision: "allow" | "deny", permissionDecisionReason: string) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } });
}

export function describeOperation(payload: HookPayload) {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "unknown tool";
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input as Record<string, unknown> : {};
  // Prefer the field that identifies the affected scope so a human can judge without opening the run.
  const scope = [input.file_path, input.command, input.path, input.url].find((candidate) => typeof candidate === "string") as string | undefined;
  return { tool, scope: scope ?? null, summary: scope ? `${tool}: ${scope}` : tool, input };
}

export async function runPermissionHook(input: string, env: PermissionHookEnvironment = process.env): Promise<string> {
  const dbPath = env.ISSUE_TRACKER_DB;
  const run = env.ISSUE_TRACKER_RUN_ID;
  const participantId = env.ISSUE_TRACKER_PARTICIPANT_ID;
  const worktreeRoot = env.ISSUE_TRACKER_WORKTREE_ROOT;
  if (!dbPath || !run || !participantId) return decision("deny", "The tracker permission hook is not configured for this run; no approval route exists.");

  let payload: HookPayload;
  try { payload = JSON.parse(input) as HookPayload; }
  catch { return decision("deny", "The tracker permission hook could not parse the tool request."); }

  const timeoutMs = positiveInteger(env.ISSUE_TRACKER_PERMISSION_TIMEOUT_MS) ?? 15 * 60_000;
  const pollMs = positiveInteger(env.ISSUE_TRACKER_PERMISSION_POLL_MS) ?? 1_000;
  const progressMs = positiveInteger(env.ISSUE_TRACKER_PERMISSION_PROGRESS_MS) ?? 60_000;
  const operation = describeOperation(payload);

  const db = openDb(dbPath);
  const context: ServiceContext = { db, actor: null, clock: systemClock };
  try {
    // Resolve operands from the validated payload cwd (where Claude Code's Bash tool opens them),
    // keeping the real worktree root as the containment target. Approval only grants permission:
    // Bash then runs with non-interactive stdin (EOF) and its own timeout, so an operand-less reader
    // (cat, grep, git shortlog) cannot block the run indefinitely.
    if (isAutoApprovable(payload, worktreeRoot)) {
      recordPermissionAutoApproval(context, { run, participantId, operation: { tool: operation.tool, scope: operation.scope, autoApproved: "read_only" } });
      return decision("allow", `Read-only inspection auto-approved by tracker: ${operation.summary}`);
    }
    const request = requestRunInput(context, {
      run, participantId, kind: "permission", blocking: true, delivery: "hook",
      providerSessionId: typeof payload.session_id === "string" ? payload.session_id : null,
      prompt: `Approve ${operation.summary}?`,
      operation: { tool: operation.tool, scope: operation.scope, input: operation.input, toolUseId: typeof payload.tool_use_id === "string" ? payload.tool_use_id : null, cwd: typeof payload.cwd === "string" ? payload.cwd : null }
    });

    const deadline = systemClock.now().getTime() + timeoutMs;
    let nextProgress = systemClock.now().getTime() + progressMs;
    while (systemClock.now().getTime() < deadline) {
      const current = getRunInputRequest(context, run, request.id);
      if (!current) return decision("deny", "The tracker permission request disappeared before it was answered.");
      if (current.state === "approved") return decision("allow", `Approved by ${current.respondedBy ?? "an operator"} via tracker.`);
      if (current.state !== "pending") return decision("deny", `The tracker permission request was ${current.state}.`);
      if (systemClock.now().getTime() >= nextProgress) { recordPermissionWaitProgress(context, run, request.id); nextProgress = systemClock.now().getTime() + progressMs; }
      await sleep(pollMs);
    }

    // A decision can land in the same instant the wait expires; expireHookPermissionWait resolves
    // that race atomically and returns the request when it was answered after all.
    const resolved = expireHookPermissionWait(context, run, request.id);
    if (resolved?.state === "approved") return decision("allow", `Approved by ${resolved.respondedBy ?? "an operator"} via tracker.`);
    if (resolved && resolved.state !== "pending") return decision("deny", `The tracker permission request was ${resolved.state}.`);
    return decision("deny", `No operator answered within ${Math.round(timeoutMs / 1000)}s. The request remains pending in tracker and will be delivered on approval by resuming this session.`);
  } catch (error) {
    return decision("deny", `The tracker permission hook failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.$client.close();
  }
}

function positiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  process.stdout.write(`${await runPermissionHook(Buffer.concat(chunks).toString("utf8"))}\n`);
}

const entrypoint = process.argv[1] && /(?:^|\/)permission-hook\.(?:js|ts)$/.test(process.argv[1]) && import.meta.url === new URL(process.argv[1], "file:").href;
if (entrypoint) void main();
