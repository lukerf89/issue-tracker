import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { participantResultSchema, type ProviderAdapter, type ProviderLaunch } from "./contract.js";
import { parseJsonLines, runProcess } from "./process.js";

export class CodexAdapter implements ProviderAdapter {
  readonly name = "codex";
  readonly capabilities = { resume: true, redirect: false, interactivePermissions: false, structuredOutput: true, childParticipants: false, usage: true };

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
    const schemaDirectory = mkdtempSync(join(tmpdir(), "tracker-codex-schema-"));
    const schemaPath = join(schemaDirectory, "participant-result.json");
    writeFileSync(schemaPath, JSON.stringify(participantResultSchema), { mode: 0o600 });
    const args = sessionId ? ["exec", "resume", sessionId] : ["exec"];
    args.push("--json", "--model", launch.model, "--output-schema", schemaPath);
    if (!sessionId && typeof launch.options?.sandbox === "string") args.push("--sandbox", launch.options.sandbox);
    args.push(launch.prompt);
    let result;
    try {
      result = await runProcess(launch.executable, args, { cwd: launch.workingDirectory, env: { ...process.env, ...launch.env }, signal, onProcess: launch.onProcess });
    } finally {
      rmSync(schemaDirectory, { recursive: true, force: true });
    }
    const raw = parseJsonLines(result.stdout);
    const terminal = [...raw].reverse().find((event): event is Record<string, unknown> => typeof event === "object" && event !== null && ["turn.completed", "task_complete"].includes(String((event as { type?: unknown }).type)));
    const finalMessage = [...raw].reverse().find((event): event is Record<string, unknown> => typeof event === "object" && event !== null && (event as { type?: unknown }).type === "item.completed" && (event as { item?: { type?: unknown } }).item?.type === "agent_message");
    const session = raw.find((event): event is Record<string, unknown> => typeof event === "object" && event !== null && ["thread.started", "thread.created"].includes(String((event as { type?: unknown }).type)));
    return {
      exitCode: result.exitCode,
      sessionId: typeof session?.thread_id === "string" ? session.thread_id : typeof session?.threadId === "string" ? session.threadId : null,
      actualModel: launch.model,
      structuredResult: parseStructured(terminal?.result ?? finalMessage?.item),
      events: raw.map((event, index) => ({ providerEventId: String((event as { id?: unknown }).id ?? index + 1), type: normalizeCodexType(event), data: sanitizeCodexEvent(event), progress: normalizeCodexType(event) !== "provider.message" })),
      rawLog: `${result.stdout}${result.stderr}`
    };
  }
}

function parseStructured(value: unknown): Record<string, unknown> | null {
  const candidate = value && typeof value === "object" && "text" in value ? (value as { text?: unknown }).text : value;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
  if (typeof candidate === "string") { try { const parsed = JSON.parse(candidate) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
  return null;
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
