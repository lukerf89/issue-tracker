import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { ServiceContext } from "../context.js";
import {
  agentRuns, issues, runActions, runArtifacts, runAttempts, runInputRequests, runParticipants, runRepositories, runReviewFindings, runVerifications
} from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import type { RunRecordCollection, RunState, RunView } from "../schemas/run.js";
import { getIssue } from "./issue.js";
import {
  decodeRunListCursor, decodeRunRecordCursor, encodeRunListCursor, encodeRunRecordCursor, runListQuery, type RecordKey
} from "./run-cursor.js";

/**
 * Compact projection of a run. It never includes the resolved configuration, worktree path, or
 * related collections; those are read explicitly via getRun (view=full) or listRunRecords.
 */
export interface RunSummary {
  id: string;
  issue: { id: string; identifier: string | null };
  profileId: string | null;
  workflow: string;
  state: RunState;
  phase: string;
  outcome: string | null;
  errorCode: string | null;
  branch: string;
  parallelGroup: string | null;
  attemptCount: number;
  eventCount: number;
  pending: { actions: number; inputRequests: number; permissionRequests: number };
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  lastEventAt: string;
  lastProgressAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

export interface RunSummaryPage { runs: RunSummary[]; nextCursor: string | null }

export interface RunRecordPage {
  run: string;
  collection: RunRecordCollection;
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

// Explicit column list: resolvedConfiguration and worktreePath are never selected for summaries.
const summaryColumns = {
  id: agentRuns.id, issueId: agentRuns.issueId, profileId: agentRuns.profileId, workflow: agentRuns.workflow,
  state: agentRuns.state, phase: agentRuns.phase, outcome: agentRuns.outcome, error: agentRuns.error, branch: agentRuns.branch,
  parallelGroup: agentRuns.parallelGroup, attemptCounter: agentRuns.attemptCounter, eventCounter: agentRuns.eventCounter,
  createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt, startedAt: agentRuns.startedAt, lastEventAt: agentRuns.lastEventAt,
  lastProgressAt: agentRuns.lastProgressAt, completedAt: agentRuns.completedAt, archivedAt: agentRuns.archivedAt
};
type SummaryRow = { [K in keyof typeof summaryColumns]: (typeof summaryColumns)[K]["_"]["data"] | ((typeof summaryColumns)[K]["_"]["notNull"] extends true ? never : null) };

/** Builds summaries for a page of base rows with a fixed number of batched queries, independent of page size. */
function buildRunSummaries(context: ServiceContext, rows: SummaryRow[]): RunSummary[] {
  if (rows.length === 0) return [];
  const runIds = rows.map((row) => row.id);
  const issueIds = [...new Set(rows.map((row) => row.issueId))];
  const identifiers = new Map(context.db.select({ id: issues.id, identifier: issues.identifier }).from(issues).where(inArray(issues.id, issueIds)).all().map((row) => [row.id, row.identifier]));
  const actions = new Map(context.db.select({ runId: runActions.runId, total: count() }).from(runActions)
    .where(and(inArray(runActions.runId, runIds), isNull(runActions.completedAt))).groupBy(runActions.runId).all().map((row) => [row.runId, row.total]));
  const requests = new Map<string, number>();
  for (const row of context.db.select({ runId: runInputRequests.runId, kind: runInputRequests.kind, total: count() }).from(runInputRequests)
    .where(and(inArray(runInputRequests.runId, runIds), eq(runInputRequests.state, "pending"))).groupBy(runInputRequests.runId, runInputRequests.kind).all()) {
    requests.set(`${row.runId}:${row.kind}`, row.total);
  }
  return rows.map((row) => ({
    id: row.id,
    issue: { id: row.issueId, identifier: identifiers.get(row.issueId) ?? null },
    profileId: row.profileId ?? null,
    workflow: row.workflow,
    state: row.state,
    phase: row.phase,
    outcome: row.outcome ?? null,
    errorCode: errorCode(row.error),
    branch: row.branch,
    parallelGroup: row.parallelGroup ?? null,
    attemptCount: row.attemptCounter,
    eventCount: row.eventCounter,
    pending: { actions: actions.get(row.id) ?? 0, inputRequests: requests.get(`${row.id}:input`) ?? 0, permissionRequests: requests.get(`${row.id}:permission`) ?? 0 },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? null,
    lastEventAt: row.lastEventAt,
    lastProgressAt: row.lastProgressAt,
    completedAt: row.completedAt ?? null,
    archivedAt: row.archivedAt ?? null
  }));
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return null;
}

/**
 * Bounded page of run summaries ordered by createdAt DESC, id DESC. Pagination is live keyset:
 * a run matching the filters on every request is returned exactly once; runs created after the
 * traversal began sort ahead of the cursor and need a fresh traversal.
 */
export function listRunSummaries(context: ServiceContext, input: { issue?: string; state?: RunState; includeArchived?: boolean; cursor?: string; limit?: number }): RunSummaryPage {
  const limit = input.limit ?? 25;
  const query = runListQuery(input);
  const after = decodeRunListCursor(input.cursor, query);
  const issueId = input.issue ? getIssue(context, input.issue).id : undefined;
  const clauses = [
    input.includeArchived ? undefined : isNull(agentRuns.archivedAt),
    issueId ? eq(agentRuns.issueId, issueId) : undefined,
    input.state ? eq(agentRuns.state, input.state) : undefined,
    after ? or(lt(agentRuns.createdAt, after[0]), and(eq(agentRuns.createdAt, after[0]), lt(agentRuns.id, after[1]))) : undefined
  ].filter((clause): clause is SQL => clause !== undefined);
  const rows = context.db.select(summaryColumns).from(agentRuns).where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(limit + 1).all() as SummaryRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { runs: buildRunSummaries(context, page), nextCursor: rows.length > limit && last ? encodeRunListCursor(query, [last.createdAt, last.id]) : null };
}

export function getRunSummary(context: ServiceContext, runId: string): RunSummary {
  const row = context.db.select(summaryColumns).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1).all()[0] as SummaryRow | undefined;
  if (!row) throw new AppError(AppErrorCode.RUN_NOT_FOUND, `Run ${runId} was not found.`, { run: runId });
  return buildRunSummaries(context, [row])[0]!;
}

/** Shapes a run-returning mutation's response: the hydrated run for view=full, a bounded post-commit summary for view=summary. */
export function runResponse<T extends { id: string }>(context: ServiceContext, run: T, view: RunView = "full"): T | RunSummary {
  return view === "summary" ? getRunSummary(context, run.id) : run;
}

interface CollectionSpec {
  table: SQLiteTable;
  runId: SQLiteColumn;
  first: SQLiteColumn;
  second: SQLiteColumn;
  keys: [string, string];
  filter?: SQL;
}

// These orders and filters mirror hydrateRun in run.ts exactly; a parity test asserts that concatenated pages equal getRun's arrays.
const COLLECTIONS: Record<RunRecordCollection, CollectionSpec> = {
  repositories: { table: runRepositories, runId: runRepositories.runId, first: runRepositories.position, second: runRepositories.repositoryId, keys: ["position", "repositoryId"] },
  attempts: { table: runAttempts, runId: runAttempts.runId, first: runAttempts.number, second: runAttempts.id, keys: ["number", "id"] },
  participants: { table: runParticipants, runId: runParticipants.runId, first: runParticipants.role, second: runParticipants.id, keys: ["role", "id"] },
  artifacts: { table: runArtifacts, runId: runArtifacts.runId, first: runArtifacts.createdAt, second: runArtifacts.id, keys: ["createdAt", "id"] },
  inputRequests: { table: runInputRequests, runId: runInputRequests.runId, first: runInputRequests.requestedAt, second: runInputRequests.id, keys: ["requestedAt", "id"] },
  verifications: { table: runVerifications, runId: runVerifications.runId, first: runVerifications.completedAt, second: runVerifications.id, keys: ["completedAt", "id"] },
  reviewFindings: { table: runReviewFindings, runId: runReviewFindings.runId, first: runReviewFindings.createdAt, second: runReviewFindings.id, keys: ["createdAt", "id"] },
  // Live view: actions completing mid-traversal drop out of later pages and are never duplicated.
  pendingActions: { table: runActions, runId: runActions.runId, first: runActions.createdAt, second: runActions.id, keys: ["createdAt", "id"], filter: isNull(runActions.completedAt) }
};

/** Independently paged read of one related collection of a run, in the same order the hydrated run embeds it. */
export function listRunRecords(context: ServiceContext, input: { run: string; collection: RunRecordCollection; cursor?: string; limit?: number }): RunRecordPage {
  const limit = input.limit ?? 25;
  const after = decodeRunRecordCursor(input.cursor, input.run, input.collection);
  if (!context.db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, input.run)).limit(1).all()[0]) {
    throw new AppError(AppErrorCode.RUN_NOT_FOUND, `Run ${input.run} was not found.`, { run: input.run });
  }
  const spec = COLLECTIONS[input.collection];
  const clauses = [
    eq(spec.runId, input.run),
    spec.filter,
    after ? or(gt(spec.first, after[0]), and(eq(spec.first, after[0]), gt(spec.second, after[1]))) : undefined
  ].filter((clause): clause is SQL => clause !== undefined);
  const rows = context.db.select().from(spec.table).where(and(...clauses)).orderBy(asc(spec.first), asc(spec.second)).limit(limit + 1).all() as Record<string, unknown>[];
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit && last ? encodeRunRecordCursor(input.run, input.collection, [last[spec.keys[0]] as string | number, last[spec.keys[1]] as string] as RecordKey) : null;
  return { run: input.run, collection: input.collection, items, nextCursor };
}
