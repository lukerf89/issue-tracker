import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isParticipantResult, participantResultOutputSchema, providerEnvironment, providerFailure, type ProviderAdapter, type ProviderLaunch, type ProviderProbe } from "./contract.js";
import { parseJsonLines, runProcess } from "./process.js";

export class CodexAdapter implements ProviderAdapter {
  readonly name = "codex";
  readonly capabilities = { resume: true, redirect: false, interactivePermissions: false, structuredOutput: true, childParticipants: false, usage: true };

  async probe(input: ProviderProbe) {
    const schemaDirectory = mkdtempSync(join(tmpdir(), "tracker-codex-health-"));
    try {
      const schemaPath = join(schemaDirectory, "health.json");
      writeFileSync(schemaPath, JSON.stringify(participantResultOutputSchema("codex", "orchestrator")), { mode: 0o600 });
      const args = ["exec", "--json", "--model", input.model, "--output-schema", schemaPath];
      appendExecutionOptions(args, input.options);
      args.push(healthPrompt("orchestrator"));
      const result = await runProcess(input.executable, args, { cwd: process.cwd(), env: providerEnvironment(input.env) });
      const failure = providerFailure(result.exitCode, `${result.stdout}\n${result.stderr}`);
      return healthFromFailure(failure);
    } catch { return { installed: false, authenticated: false, modelAccessible: false, diagnosticCode: "engine_not_installed", remediation: "Install Codex or correct the configured executable." }; }
    finally { rmSync(schemaDirectory, { recursive: true, force: true }); }
  }

  async run(launch: ProviderLaunch, signal?: AbortSignal) {
    return await this.execute(launch, null, signal);
  }

  async resume(launch: ProviderLaunch, sessionId: string, signal?: AbortSignal) {
    return await this.execute(launch, sessionId, signal);
  }

  private async execute(launch: ProviderLaunch, sessionId: string | null, signal?: AbortSignal) {
    const schemaDirectory = mkdtempSync(join(tmpdir(), "tracker-codex-schema-"));
    const schemaPath = join(schemaDirectory, "participant-result.json");
    writeFileSync(schemaPath, JSON.stringify(participantResultOutputSchema("codex", launch.role)), { mode: 0o600 });
    const args = sessionId ? ["exec", "resume", sessionId] : ["exec"];
    args.push("--json", "--model", launch.model, "--output-schema", schemaPath);
    appendExecutionOptions(args, launch.options, sessionId !== null);
    args.push(launch.prompt);
    let result;
    try {
      // This OS jail is additive to Codex's own --sandbox confinement. Full coverage of the read
      // paths used by Codex's Seatbelt helper remains follow-up work.
      result = await runProcess(launch.executable, args, { cwd: launch.workingDirectory, env: providerEnvironment(launch.env), signal, onProcess: launch.onProcess, sandbox: launch.options?.osSandbox === true ? { worktree: launch.workingDirectory, executable: launch.executable, hook: null } : null });
    } finally {
      rmSync(schemaDirectory, { recursive: true, force: true });
    }
    const raw = parseJsonLines(result.stdout);
    const terminal = [...raw].reverse().find((event): event is Record<string, unknown> => typeof event === "object" && event !== null && ["turn.completed", "task_complete"].includes(String((event as { type?: unknown }).type)));
    const finalMessage = [...raw].reverse().find((event): event is Record<string, unknown> => typeof event === "object" && event !== null && (event as { type?: unknown }).type === "item.completed" && (event as { item?: { type?: unknown } }).item?.type === "agent_message");
    const session = raw.find((event): event is Record<string, unknown> => typeof event === "object" && event !== null && ["thread.started", "thread.created"].includes(String((event as { type?: unknown }).type)));
    const candidate = terminal?.result ?? finalMessage?.item;
    const structuredResult = parseStructured(candidate);
    const failure = providerFailure(result.exitCode, `${result.stdout}\n${result.stderr}`) ?? invalidResultFailure(result.exitCode, candidate, structuredResult);
    return {
      exitCode: result.exitCode,
      sessionId: typeof session?.thread_id === "string" ? session.thread_id : typeof session?.threadId === "string" ? session.threadId : null,
      actualModel: explicitModel(raw),
      structuredResult,
      events: raw.map((event, index) => ({ providerEventId: String((event as { id?: unknown }).id ?? index + 1), type: normalizeCodexType(event), data: sanitizeCodexEvent(event), progress: normalizeCodexType(event) !== "provider.message" })),
      rawLog: `${result.stdout}${result.stderr}`,
      failure
    };
  }
}

function appendExecutionOptions(args: string[], options?: Record<string, unknown>, resumed = false) {
  // `codex exec resume` rejects --sandbox, and a resumed turn otherwise silently reverts to the
  // config-default sandbox rather than inheriting the session's. Verified against codex-cli 0.144:
  // a session launched `--sandbox read-only` resumed as `danger-full-access`, widening confinement
  // mid-run with no flag on the argv. Re-assert the operator's sandbox as a `--config` override,
  // which resume does accept, so every turn runs under the sandbox the first turn was given.
  if (typeof options?.sandbox === "string") {
    if (resumed) args.push("--config", `sandbox_mode=${options.sandbox}`);
    else args.push("--sandbox", options.sandbox);
  }
  if (typeof options?.reasoningEffort === "string") args.push("--config", `model_reasoning_effort=${options.reasoningEffort}`);
}

function invalidResultFailure(exitCode: number | null, candidate: unknown, structuredResult: Record<string, unknown> | null) {
  return exitCode === 0 && candidate !== undefined && structuredResult === null ? { code: "provider_result_invalid" as const, message: "The provider returned a result that did not match the participant contract." } : null;
}

function healthPrompt(role: string) { return `Return only this structured no-op result: ${JSON.stringify({ role, summary: "Provider health check", files: [], tests: [], risks: [], findings: [], verifiedTestsPassed: true, riskNotes: [] })}`; }
function healthFromFailure(failure: { code: string; message: string } | null) {
  if (!failure) return { installed: true, authenticated: true, modelAccessible: true, diagnosticCode: null, remediation: null };
  return { installed: true, authenticated: failure.code !== "provider_authentication_failed", modelAccessible: !["provider_authentication_failed", "provider_model_unavailable"].includes(failure.code), diagnosticCode: failure.code, remediation: failure.code === "provider_authentication_failed" ? "Authenticate Codex and restart tracker-agentd." : failure.code === "provider_model_unavailable" ? "Configure a Codex model available to this account." : "Update the Codex provider configuration, then restart tracker-agentd." };
}

function explicitModel(events: unknown[]) {
  for (const event of [...events].reverse()) {
    if (!event || typeof event !== "object") continue;
    const value = event as { model?: unknown; response?: { model?: unknown } };
    const model = typeof value.model === "string" ? value.model : typeof value.response?.model === "string" ? value.response.model : null;
    if (model) return model;
  }
  return null;
}

function parseStructured(value: unknown): Record<string, unknown> | null {
  const candidate = value && typeof value === "object" && "text" in value ? (value as { text?: unknown }).text : value;
  const parsed = typeof candidate === "string" ? (() => { try { return JSON.parse(candidate) as unknown; } catch { return null; } })() : candidate;
  return isParticipantResult(parsed) ? parsed : null;
}

function normalizeCodexType(event: unknown) {
  const type = event && typeof event === "object" ? String((event as { type?: unknown }).type ?? "") : "";
  if (type.includes("completed") || type === "task_complete") return "participant.result";
  if (type.includes("started") || type.includes("created")) return "participant.session";
  if (type.includes("item") || type.includes("turn")) return "participant.progress";
  return "provider.message";
}

function sanitizeCodexEvent(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== "object") return { providerType: "raw" };
  const value = event as { type?: unknown; thread_id?: unknown; threadId?: unknown; item?: { id?: unknown; type?: unknown; status?: unknown }; usage?: unknown; error?: { code?: unknown } };
  return {
    providerType: String(value.type ?? "unknown"),
    threadId: typeof value.thread_id === "string" ? value.thread_id : typeof value.threadId === "string" ? value.threadId : null,
    itemId: typeof value.item?.id === "string" ? value.item.id : null,
    itemType: typeof value.item?.type === "string" ? value.item.type : null,
    status: typeof value.item?.status === "string" ? value.item.status : null,
    usage: value.usage && typeof value.usage === "object" ? value.usage : null,
    errorCode: typeof value.error?.code === "string" ? value.error.code : null
  };
}
