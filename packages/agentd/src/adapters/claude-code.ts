import { participantResultSchema, type ProviderAdapter, type ProviderLaunch } from "./contract.js";
import { parseJsonLines, runProcess } from "./process.js";

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly name = "claude-code";
  readonly capabilities = { resume: true, redirect: false, interactivePermissions: true, structuredOutput: true, childParticipants: false, usage: true };

  async probe(executable: string) {
    try {
      const result = await runProcess(executable, ["--version"], { cwd: process.cwd() });
      return { installed: result.exitCode === 0, authenticated: result.exitCode === 0, diagnostic: result.exitCode === 0 ? null : result.stderr.trim() };
    } catch (error) { return { installed: false, authenticated: false, diagnostic: error instanceof Error ? error.message : String(error) }; }
  }

  async run(launch: ProviderLaunch, signal?: AbortSignal) {
    return await this.execute(launch, null, signal);
  }

  async resume(launch: ProviderLaunch, sessionId: string, signal?: AbortSignal) {
    return await this.execute(launch, sessionId, signal);
  }

  private async execute(launch: ProviderLaunch, sessionId: string | null, signal?: AbortSignal) {
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--model", launch.model, "--json-schema", JSON.stringify(participantResultSchema)];
    if (sessionId) args.push("--resume", sessionId);
    if (launch.options?.permissionMode === "autonomous") args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", "default");
    args.push(launch.prompt);
    const result = await runProcess(launch.executable, args, { cwd: launch.workingDirectory, env: { ...process.env, ...launch.env }, signal, onProcess: launch.onProcess });
    const raw = parseJsonLines(result.stdout);
    const terminal = [...raw].reverse().find((event): event is Record<string, unknown> => typeof event === "object" && event !== null && (event as { type?: unknown }).type === "result");
    return {
      exitCode: result.exitCode,
      sessionId: typeof terminal?.session_id === "string" ? terminal.session_id : null,
      actualModel: typeof terminal?.model === "string" ? terminal.model : launch.model,
      structuredResult: parseStructured(terminal?.result),
      events: raw.map((event, index) => ({ providerEventId: String((event as { uuid?: unknown }).uuid ?? index + 1), type: normalizeClaudeType(event), data: sanitizeClaudeEvent(event), progress: normalizeClaudeType(event) !== "provider.message" })),
      rawLog: `${result.stdout}${result.stderr}`
    };
  }
}

function parseStructured(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
  return null;
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
