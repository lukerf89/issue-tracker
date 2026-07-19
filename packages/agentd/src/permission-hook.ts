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

/**
 * Command prefixes that cannot alter the worktree, the repository, or anything outside them. Each
 * entry must be read-only *including every flag it accepts*, which is why several obvious
 * candidates are absent: `git branch` deletes with -D, `git remote` mutates with `add`, `find`
 * writes with -delete and -exec, `sed` edits in place with -i, and `sort` writes with -o.
 */
const READ_ONLY_COMMANDS = [
  ["git", "status"], ["git", "log"], ["git", "show"], ["git", "diff"], ["git", "ls-tree"],
  ["git", "ls-files"], ["git", "rev-parse"], ["git", "cat-file"], ["git", "blame"],
  ["git", "describe"], ["git", "shortlog"],
  ["ls"], ["pwd"], ["cat"], ["head"], ["tail"], ["wc"], ["od"], ["stat"], ["file"],
  ["basename"], ["dirname"], ["echo"], ["which"], ["grep"], ["rg"], ["diff"], ["true"]
];

/**
 * Shell syntax that can chain, substitute, or redirect. Any of these means the command is more than
 * the program its first token names, so prefix matching would no longer describe what runs. Such a
 * command is never auto-approved regardless of how it starts.
 */
const SHELL_CONTROL = /[;&|`$(){}<>\n\r\\!*?[\]]/;

/**
 * Flags accepted on an auto-approved command. Matching the command name alone is not sound: several
 * read-only programs execute or write when given the right flag — `rg --pre <cmd>` runs an arbitrary
 * preprocessor binary, and `git diff --output=<path>` creates a file. Anything not named here is
 * gated for a human rather than guessed at, so an unrecognized flag fails closed.
 */
const SAFE_FLAGS = new Set([
  "-a", "-A", "-b", "-B", "-c", "-C", "-e", "-h", "-i", "-l", "-L", "-n", "-p", "-q", "-r", "-R",
  "-s", "-S", "-t", "-u", "-v", "-w", "-la", "-al", "-lh", "-ll", "-lr", "-rl",
  "--all", "--abbrev-commit", "--branch", "--cached", "--color", "--decorate", "--graph",
  "--human-readable", "--ignore-case", "--long", "--name-only", "--name-status", "--no-color",
  "--no-pager", "--numstat", "--oneline", "--porcelain", "--reverse", "--short", "--staged",
  "--stat", "--summary", "--word-diff"
]);

/** Value-bearing flags that cannot redirect output or execute a program. */
const SAFE_VALUE_FLAGS = /^--(format|pretty|max-count|since|until|author|grep)=/;

function isSafeFlag(token: string) {
  if (!token.startsWith("-")) return true;
  if (/^-\d+$/.test(token)) return true; // count shorthand such as `git log -5`
  return SAFE_FLAGS.has(token) || SAFE_VALUE_FLAGS.test(token);
}

export function isReadOnlyCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL.test(trimmed)) return false;
  // Quoted arguments can hide separators from a naive token split, so only bare tokens qualify.
  if (/["']/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.some((token) => token === "--")) return false;
  const prefix = READ_ONLY_COMMANDS.find((candidate) => candidate.every((word, index) => tokens[index] === word));
  if (!prefix) return false;
  // Every argument past the matched command must be a known-safe flag or a plain operand.
  return tokens.slice(prefix.length).every(isSafeFlag);
}

/** Read-only inspection is auto-approved; everything that can mutate or leave the machine is not. */
export function isAutoApprovable(payload: HookPayload): boolean {
  if (payload.tool_name !== "Bash") return false;
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input as Record<string, unknown> : {};
  return isReadOnlyCommand(input.command);
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
    if (isAutoApprovable(payload)) {
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
