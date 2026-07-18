import { asc } from "drizzle-orm";

import type { ServiceContext } from "../context.js";
import { agentRuns, runEvents } from "../db/schema.js";

export function getRunMetrics(context: ServiceContext) {
  const runs = context.db.query.agentRuns.findMany({ orderBy: [asc(agentRuns.createdAt), asc(agentRuns.id)] }).sync();
  const events = context.db.query.runEvents.findMany({ orderBy: [asc(runEvents.runId), asc(runEvents.sequence)] }).sync();
  const outcomes = Object.fromEntries([...new Set(runs.map((run) => run.state))].sort().map((state) => [state, runs.filter((run) => run.state === state).length]));
  return {
    totalRuns: runs.length,
    activeRuns: runs.filter((run) => !run.completedAt).length,
    outcomes,
    fallbackCount: events.filter((event) => event.type === "attempt.created" && (event.data as { reason?: unknown }).reason === "fallback").length,
    stallCount: events.filter((event) => event.type === "run.stalled").length,
    verificationDisagreementCount: events.filter((event) => event.type === "verification.completed" && (event.data as { classification?: unknown }).classification === "audit_drift").length,
    averageDurationMs: average(runs.filter((run) => run.completedAt).map((run) => new Date(run.completedAt!).getTime() - new Date(run.createdAt).getTime()))
  };
}

function average(values: number[]) { return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null; }
