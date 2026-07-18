import { setTimeout as sleep } from "node:timers/promises";

import { expireHookPermissionWait, getRunInputRequest, openDb, recordPermissionWaitProgress, requestRunInput, systemClock, type ServiceContext } from "@issue-tracker/core";

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
