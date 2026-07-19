import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderSandbox } from "../sandbox.js";
import { isParticipantResult, participantResultOutputSchema, providerEnvironment, providerFailure, type ProviderAdapter, type ProviderLaunch, type ProviderProbe } from "./contract.js";
import { parseJsonLines, runProcess } from "./process.js";

/** Tools that mutate the worktree, execute commands, or leave the machine. Read-only tools are not
 * gated: they cannot change state, and routing them to a human would make every run unanswerable. */
const GATED_TOOLS = "Write|Edit|MultiEdit|NotebookEdit|Bash|WebFetch";

export function resolvePermissionHookScript() {
  const override = process.env.ISSUE_TRACKER_PERMISSION_HOOK_SCRIPT;
  if (override) return override;
  const compiled = fileURLToPath(new URL("../permission-hook.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  // Running from TypeScript sources (tests): fall back to the built artifact for the same package.
  const built = compiled.replace(`${join("", "src", "")}`, `${join("", "dist", "")}`).replace("/src/", "/dist/");
  if (existsSync(built)) return built;
  throw new Error(`The tracker permission hook script was not found at ${compiled} or ${built}; build @issue-tracker/agentd first.`);
}

function writePermissionSettings(hook: { dbPath: string; runId: string; timeoutMs?: number }) {
  const directory = mkdtempSync(join(tmpdir(), "tracker-permission-"));
  const path = join(directory, "settings.json");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolvePermissionHookScript())}`;
  const timeoutMs = hook.timeoutMs ?? 15 * 60_000;
  // The hook timeout must outlast the wait it supervises, otherwise Claude Code kills the hook
  // before it can convert the request to resume delivery and the decision is lost.
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: GATED_TOOLS, hooks: [{ type: "command", command, timeout: Math.ceil(timeoutMs / 1000) + 30 }] }] } }), { mode: 0o600 });
  return { directory, path, env: { ISSUE_TRACKER_DB: hook.dbPath, ISSUE_TRACKER_RUN_ID: hook.runId, ISSUE_TRACKER_PERMISSION_TIMEOUT_MS: String(timeoutMs) } };
}

/**
 * Builds the OS Seatbelt jail descriptor for a Claude Code launch, or null when the operator did
 * not opt in via `osSandbox`. When a durable permission hook is present the jail additionally
 * allowlists the hook's DB control channel so an approved mutation can still be adjudicated. This
 * is the single wiring point between the `osSandbox` flag and the kernel jail; keeping it a pure,
 * exported function lets tests assert the flag actually engages the sandbox rather than silently
 * no-opping.
 */
export function claudeCodeSandbox(launch: ProviderLaunch): ProviderSandbox | null {
  if (launch.options?.osSandbox !== true) return null;
  return {
    worktree: launch.workingDirectory,
    executable: launch.executable,
    hook: launch.permissionHook ? { dbPath: launch.permissionHook.dbPath, hookScriptPath: resolvePermissionHookScript() } : null
  };
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly name = "claude-code";
  readonly capabilities = { resume: true, redirect: false, interactivePermissions: true, structuredOutput: true, childParticipants: false, usage: true };

  async probe(input: ProviderProbe) {
    try {
      const schema = participantResultOutputSchema("claude-code", "orchestrator");
      const result = await runProcess(input.executable, ["--print", "--output-format", "json", "--model", input.model, "--json-schema", JSON.stringify(schema), healthPrompt("orchestrator")], { cwd: process.cwd(), env: providerEnvironment(input.env) });
      const failure = providerFailure(result.exitCode, `${result.stdout}\n${result.stderr}`);
      return healthFromFailure(failure);
    } catch { return { installed: false, authenticated: false, modelAccessible: false, diagnosticCode: "engine_not_installed", remediation: "Install Claude Code or correct the configured executable." }; }
  }

  async run(launch: ProviderLaunch, signal?: AbortSignal) {
    return await this.execute(launch, null, signal);
  }

  async resume(launch: ProviderLaunch, sessionId: string, signal?: AbortSignal) {
    return await this.execute(launch, sessionId, signal);
  }

  private async execute(launch: ProviderLaunch, sessionId: string | null, signal?: AbortSignal) {
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--model", launch.model, "--json-schema", JSON.stringify(participantResultOutputSchema("claude-code", launch.role))];
    if (sessionId) args.push("--resume", sessionId);
    // An optional OS Seatbelt jail provides defense-in-depth beneath the still-required permission
    // hook, which adjudicates every mutating tool call in autonomous mode.
    if (launch.options?.permissionMode === "autonomous" && !launch.permissionHook) throw new Error("Claude Code autonomous mode requires a durable permission hook; no approval route was configured.");
    const settings = launch.permissionHook ? writePermissionSettings(launch.permissionHook) : null;
    if (settings) args.push("--settings", settings.path);
    // The mode stays `default` deliberately: the hook grants permission per call, so nothing is
    // pre-approved and no blanket acceptEdits or bypassPermissions grant is ever issued.
    args.push("--permission-mode", "default");
    args.push(launch.prompt);
    const env = { ...providerEnvironment(launch.env), ...settings?.env, ...(settings ? { ISSUE_TRACKER_PARTICIPANT_ID: launch.participantId } : {}) };
    try {
      return await this.collect(launch, args, env, signal);
    } finally {
      if (settings) rmSync(settings.directory, { recursive: true, force: true });
    }
  }

  private async collect(launch: ProviderLaunch, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
    const result = await runProcess(launch.executable, args, { cwd: launch.workingDirectory, env, signal, onProcess: launch.onProcess, sandbox: claudeCodeSandbox(launch) });
    const raw = parseJsonLines(result.stdout);
    const terminal = [...raw].reverse().find((event): event is Record<string, unknown> => typeof event === "object" && event !== null && (event as { type?: unknown }).type === "result");
    const structuredResult = parseStructured(terminal?.result);
    const failure = providerFailure(result.exitCode, `${result.stdout}\n${result.stderr}`) ?? invalidResultFailure(result.exitCode, terminal?.result, structuredResult);
    return {
      exitCode: result.exitCode,
      sessionId: typeof terminal?.session_id === "string" ? terminal.session_id : null,
      actualModel: explicitModel(raw),
      structuredResult,
      events: raw.map((event, index) => ({ providerEventId: String((event as { uuid?: unknown }).uuid ?? index + 1), type: normalizeClaudeType(event), data: sanitizeClaudeEvent(event), progress: normalizeClaudeType(event) !== "provider.message" })),
      rawLog: `${result.stdout}${result.stderr}`,
      failure
    };
  }
}

function explicitModel(events: unknown[]) {
  for (const event of [...events].reverse()) if (event && typeof event === "object" && typeof (event as { model?: unknown }).model === "string") return (event as { model: string }).model;
  return null;
}

function invalidResultFailure(exitCode: number | null, candidate: unknown, structuredResult: Record<string, unknown> | null) {
  return exitCode === 0 && candidate !== undefined && structuredResult === null ? { code: "provider_result_invalid" as const, message: "The provider returned a result that did not match the participant contract." } : null;
}

function healthPrompt(role: string) { return `Return only this structured no-op result: ${JSON.stringify({ role, summary: "Provider health check", files: [], tests: [], risks: [], findings: [], verifiedTestsPassed: true, riskNotes: [] })}`; }
function healthFromFailure(failure: { code: string; message: string } | null) {
  if (!failure) return { installed: true, authenticated: true, modelAccessible: true, diagnosticCode: null, remediation: null };
  return { installed: true, authenticated: failure.code !== "provider_authentication_failed", modelAccessible: !["provider_authentication_failed", "provider_model_unavailable"].includes(failure.code), diagnosticCode: failure.code, remediation: failure.code === "provider_authentication_failed" ? "Authenticate Claude Code and restart tracker-agentd." : failure.code === "provider_model_unavailable" ? "Configure a Claude model available to this account." : "Update the Claude Code provider configuration, then restart tracker-agentd." };
}

function parseStructured(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  return isParticipantResult(parsed) ? parsed : null;
}

function normalizeClaudeType(event: unknown) {
  if (!event || typeof event !== "object") return "provider.message";
  const type = (event as { type?: unknown }).type;
  if (type === "result") return "participant.result";
  if (type === "assistant") return "participant.progress";
  if (type === "system") return "participant.session";
  return "provider.message";
}

function sanitizeClaudeEvent(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== "object") return { providerType: "raw" };
  const value = event as { type?: unknown; subtype?: unknown; uuid?: unknown; session_id?: unknown; model?: unknown; usage?: unknown; is_error?: unknown };
  return {
    providerType: String(value.type ?? "unknown"),
    subtype: typeof value.subtype === "string" ? value.subtype : null,
    eventId: typeof value.uuid === "string" ? value.uuid : null,
    sessionId: typeof value.session_id === "string" ? value.session_id : null,
    model: typeof value.model === "string" ? value.model : null,
    usage: value.usage && typeof value.usage === "object" ? value.usage : null,
    isError: value.is_error === true
  };
}
