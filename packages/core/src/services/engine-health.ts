import { createHash } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { type ServiceContext } from "../context.js";
import { engineHealth } from "../db/schema.js";
import { type EngineDefinition } from "../schemas/engine.js";

export const engineHealthSnapshotSchema = z.object({
  engineName: z.string().min(1), fingerprint: z.string().min(16), installed: z.boolean(), authenticated: z.boolean(), modelAccessible: z.boolean(),
  diagnosticCode: z.string().min(1).nullable(), remediation: z.string().min(1).nullable(), checkedAt: z.string().datetime()
}).strict();

export type EngineHealthSnapshot = z.infer<typeof engineHealthSnapshotSchema>;

/** Every probe is a real model call, so healthy results are trusted for hours rather than minutes. */
export const DEFAULT_ENGINE_HEALTH_TTL_MS = 6 * 60 * 60_000;
/** An unhealthy result is re-probed sooner so a transient outage does not block runs for the full TTL. */
export const FAILED_ENGINE_HEALTH_TTL_MS = 15 * 60_000;

export function resolveEngineHealthTtlMs(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number(env.ISSUE_TRACKER_ENGINE_HEALTH_TTL_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_ENGINE_HEALTH_TTL_MS;
}

export function engineHealthFresh(snapshot: EngineHealthSnapshot | null, now: Date, ttlMs: number) {
  if (!snapshot) return false;
  const healthy = snapshot.installed && snapshot.authenticated && snapshot.modelAccessible && !snapshot.diagnosticCode;
  return now.getTime() - Date.parse(snapshot.checkedAt) <= (healthy ? ttlMs : Math.min(ttlMs, FAILED_ENGINE_HEALTH_TTL_MS));
}

export function engineHealthFingerprint(name: string, engine: EngineDefinition) {
  return createHash("sha256").update(stableStringify({ name, adapter: engine.adapter, executable: engine.executable, model: engine.model, reasoningEffort: engine.reasoningEffort ?? null, sandbox: engine.sandbox ?? null, writableRoots: [...(engine.writableRoots ?? [])].sort(), permissionMode: engine.permissionMode, envNames: [...engine.envNames].sort() })).digest("hex");
}

export function recordEngineHealth(context: ServiceContext, input: Omit<EngineHealthSnapshot, "checkedAt"> & { checkedAt?: string }) {
  const row = engineHealthSnapshotSchema.parse({ ...input, checkedAt: input.checkedAt ?? context.clock.now().toISOString() });
  context.db.insert(engineHealth).values(row).onConflictDoUpdate({ target: [engineHealth.engineName, engineHealth.fingerprint], set: row }).run();
  return row;
}

export function getEngineHealth(context: ServiceContext, engineName: string, fingerprint: string) {
  return context.db.query.engineHealth.findFirst({ where: and(eq(engineHealth.engineName, engineName), eq(engineHealth.fingerprint, fingerprint)) }).sync() ?? null;
}

export function listEngineHealth(context: ServiceContext) {
  return context.db.query.engineHealth.findMany({ orderBy: [asc(engineHealth.engineName), asc(engineHealth.fingerprint)] }).sync();
}

export function engineHealthProblem(snapshot: EngineHealthSnapshot | null, now: Date, ttlMs: number) {
  if (!snapshot) return { code: "engine_health_missing", message: "Provider health has not been checked.", remediation: "Start tracker-agentd to probe configured engines, then preview again." };
  if (now.getTime() - Date.parse(snapshot.checkedAt) > ttlMs) return { code: "engine_health_stale", message: "Provider health evidence is stale.", remediation: "Start tracker-agentd to refresh provider health, then preview again." };
  if (!snapshot.installed) return { code: snapshot.diagnosticCode ?? "engine_not_installed", message: "The provider executable is unavailable.", remediation: snapshot.remediation ?? "Install the configured provider executable." };
  if (!snapshot.authenticated) return { code: snapshot.diagnosticCode ?? "provider_authentication_failed", message: "Provider authentication is unavailable.", remediation: snapshot.remediation ?? "Authenticate the provider and restart tracker-agentd." };
  if (!snapshot.modelAccessible) return { code: snapshot.diagnosticCode ?? "provider_model_unavailable", message: "The configured model is unavailable.", remediation: snapshot.remediation ?? "Choose an accessible model and restart tracker-agentd." };
  if (snapshot.diagnosticCode) return { code: snapshot.diagnosticCode, message: "The provider health probe failed.", remediation: snapshot.remediation ?? "Correct the provider configuration and restart tracker-agentd." };
  return null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
