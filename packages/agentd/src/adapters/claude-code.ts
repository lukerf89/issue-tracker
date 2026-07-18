import { isParticipantResult, participantResultOutputSchema, providerEnvironment, providerFailure, type ProviderAdapter, type ProviderLaunch, type ProviderProbe } from "./contract.js";
import { parseJsonLines, runProcess } from "./process.js";

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
    if (launch.options?.permissionMode === "autonomous") throw new Error("Claude Code autonomous mode is unsupported without a worktree-scoped sandbox.");
    args.push("--permission-mode", "default");
    args.push(launch.prompt);
    const result = await runProcess(launch.executable, args, { cwd: launch.workingDirectory, env: providerEnvironment(launch.env), signal, onProcess: launch.onProcess });
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
