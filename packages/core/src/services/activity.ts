import { and, asc, eq, gt, or, sql, type SQL } from "drizzle-orm";

import { inTransaction, type ServiceContext, type ServiceTransaction } from "../context.js";
import {
  actors,
  activity,
  issues,
  teams,
  type Activity,
  type Actor,
  type Issue
} from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { getProject } from "./project.js";

export const DEFAULT_ACTIVITY_FEED_LIMIT = 100;
export const DEFAULT_ACTIVITY_PAGE_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 500;

export interface AppendActivityInput {
  issueId: string;
  actorId: string;
  action: string;
  data: Record<string, unknown>;
}

export interface ListActivityInput {
  issue: string;
}

export interface ListActivitySinceInput {
  cursor?: string | number | null;
  team?: string;
  assignee?: string;
  /** Issue id or identifier (archived issues included). Unknown -> ISSUE_NOT_FOUND. */
  issue?: string;
  /** Project id or name (archived projects included). Unknown -> PROJECT_NOT_FOUND. */
  project?: string;
  limit?: number;
}

export interface ListActivityPageInput {
  issue: string;
  after?: string | number | null;
  limit?: number;
  full?: boolean;
}

export type ActivityWithActor = Activity & { actor: Actor };

export interface ActivityFeedIssue {
  id: string;
  identifier: string;
  teamId: string;
  number: number;
  title: string;
}

export type ActivityFeedEvent = ActivityWithActor & {
  cursor: string;
  issue: ActivityFeedIssue;
  issueIdentifier: string;
};

export interface ActivityFeed {
  events: ActivityFeedEvent[];
  /** Last returned event cursor, or the input cursor echoed when the page is empty. */
  cursor: string;
  /** True when more events matching the filters exist after `cursor`. */
  hasMore: boolean;
}

export type ActivityPageEntry = ActivityWithActor & { cursor: string };

export interface ActivityPage {
  issue: { id: string; identifier: string };
  entries: ActivityPageEntry[];
  cursor: string;
  hasMore: boolean;
}

export function appendActivity(context: ServiceContext, input: AppendActivityInput) {
  return inTransaction(context, (txContext) => appendActivityInTransaction(txContext, input));
}

export function appendActivityInTransaction(
  context: ServiceContext & { db: ServiceTransaction },
  input: AppendActivityInput
) {
  const now = context.clock.now().toISOString();
  const row = {
    id: uuid(),
    issueId: input.issueId,
    actorId: input.actorId,
    action: input.action,
    data: input.data,
    createdAt: now
  };

  context.db.insert(activity).values(row).run();
  return row;
}

export function listActivity(
  context: ServiceContext,
  input: ListActivityInput
): ActivityWithActor[] {
  const issue = getIssueByIdOrIdentifier(context, input.issue);

  return context.db
    .select({
      entry: activity,
      actor: actors
    })
    .from(activity)
    .innerJoin(actors, eq(actors.id, activity.actorId))
    .where(eq(activity.issueId, issue.id))
    .orderBy(asc(activity.createdAt), sql`${activity}.rowid`)
    .all()
    .map(({ entry, actor }) => ({
      ...entry,
      data: parseActivityData(entry.data),
      actor
    }));
}

/**
 * Incremental activity feed ordered by append order (activity.rowid).
 *
 * Cursor semantics: `cursor` is an exclusive high-water mark. Every event with
 * rowid <= cursor is permanently skipped, whether or not it matched the filters
 * at the time. Filters (team, assignee, issue, project) are evaluated against the
 * CURRENT issue attributes at query time, not attributes at event time.
 */
export function listActivitySince(
  context: ServiceContext,
  input: ListActivitySinceInput = {}
): ActivityFeed {
  const cursor = normalizeCursor(input.cursor, "cursor");
  const limit = normalizeLimit(input.limit, DEFAULT_ACTIVITY_FEED_LIMIT);
  assertCursorNotAhead(context, cursor, "cursor");
  const conditions: SQL[] = [];

  if (input.team) {
    const teamCondition = or(
      eq(issues.teamId, input.team),
      eq(teams.key, normalizeTeamKey(input.team))
    );
    if (teamCondition) conditions.push(teamCondition);
  }

  if (input.assignee) {
    conditions.push(
      sql`(${issues.assigneeId} = ${input.assignee} or ${issues.assigneeId} in (select id from ${actors} where ${actors.handle} = ${input.assignee}))`
    );
  }

  if (input.issue) {
    const issue = getIssueByIdOrIdentifier(context, input.issue);
    conditions.push(eq(activity.issueId, issue.id));
  }

  if (input.project) {
    const project = getProject(context, input.project);
    conditions.push(eq(issues.projectId, project.id));
  }

  const page = selectActivityPage(context, { after: cursor, limit, conditions });

  const events = page.rows.map(({ cursor: eventCursor, entry, actor, issue }) => ({
    ...entry,
    data: parseActivityData(entry.data),
    actor,
    issue,
    issueIdentifier: issue.identifier,
    cursor: eventCursor
  }));

  return { events, cursor: page.cursor, hasMore: page.hasMore };
}

/**
 * Bounded per-issue history page ordered by append order (activity.rowid), with
 * an exclusive `after` cursor sharing the feed's cursor grammar. The legacy
 * full-history path (`listActivity`) keeps createdAt-then-rowid ordering.
 */
export function listIssueActivityPage(
  context: ServiceContext,
  input: ListActivityPageInput
): ActivityPage {
  const issue = getIssueByIdOrIdentifier(context, input.issue);
  const after = normalizeCursor(input.after, "after");
  const limit = normalizeLimit(input.limit, DEFAULT_ACTIVITY_PAGE_LIMIT);
  assertCursorNotAhead(context, after, "after");

  const page = selectActivityPage(context, {
    after,
    limit,
    conditions: [eq(activity.issueId, issue.id)]
  });

  return {
    issue: { id: issue.id, identifier: issue.identifier },
    entries: page.rows.map(({ cursor, entry, actor }) => ({
      ...entry,
      data: parseActivityData(entry.data),
      actor,
      cursor
    })),
    cursor: page.cursor,
    hasMore: page.hasMore
  };
}

function selectActivityPage(
  context: ServiceContext,
  input: { after: number; limit: number; conditions: SQL[] }
) {
  const rowid = sql<number>`${activity}.rowid`;
  const rows = context.db
    .select({
      cursor: rowid,
      entry: activity,
      actor: actors,
      issue: {
        id: issues.id,
        identifier: issues.identifier,
        teamId: issues.teamId,
        number: issues.number,
        title: issues.title
      }
    })
    .from(activity)
    .innerJoin(actors, eq(actors.id, activity.actorId))
    .innerJoin(issues, eq(issues.id, activity.issueId))
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(and(gt(rowid, input.after), ...input.conditions))
    .orderBy(rowid)
    .limit(input.limit + 1)
    .all();

  const hasMore = rows.length > input.limit;
  const page = (hasMore ? rows.slice(0, input.limit) : rows).map((row) => ({
    ...row,
    cursor: String(row.cursor)
  }));

  return {
    rows: page,
    hasMore,
    cursor: page.at(-1)?.cursor ?? String(input.after)
  };
}

function assertCursorNotAhead(context: ServiceContext, cursor: number, field: string): void {
  if (cursor === 0) return;
  const latest = context.db
    .select({ latest: sql<number>`coalesce(max(${activity}.rowid), 0)` })
    .from(activity)
    .get()?.latest ?? 0;

  if (cursor > latest) {
    throw new AppError(
      AppErrorCode.VALIDATION_FAILED,
      `Activity ${field} ${cursor} is ahead of the latest activity cursor ${latest}.`,
      { [field]: String(cursor), latestCursor: String(latest) }
    );
  }
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_LIMIT) {
    throw new AppError(
      AppErrorCode.VALIDATION_FAILED,
      `Activity limit must be an integer between 1 and ${MAX_ACTIVITY_LIMIT}.`,
      { limit }
    );
  }
  return limit;
}

function getIssueByIdOrIdentifier(context: ServiceContext, idOrIdentifier: string): Issue {
  const issue =
    context.db.query.issues.findFirst({ where: eq(issues.id, idOrIdentifier) }).sync() ??
    context.db.query.issues.findFirst({ where: eq(issues.identifier, idOrIdentifier) }).sync();

  if (!issue) {
    throw new AppError(
      AppErrorCode.ISSUE_NOT_FOUND,
      `Issue ${idOrIdentifier} was not found.`,
      { identifier: idOrIdentifier }
    );
  }

  return issue;
}

function parseActivityData(data: unknown): Record<string, unknown> {
  const parsed = typeof data === "string" ? JSON.parse(data) as unknown : data;
  return isRecord(parsed) ? parsed : {};
}

function normalizeCursor(cursor: ListActivitySinceInput["cursor"], field = "cursor"): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const parsed = typeof cursor === "number" ? cursor : Number.parseInt(cursor, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== String(cursor)) {
    throw new AppError(
      AppErrorCode.VALIDATION_FAILED,
      `Activity ${field} ${String(cursor)} is not valid.`,
      { [field]: cursor }
    );
  }

  return parsed;
}

function normalizeTeamKey(key: string): string {
  return key.trim().toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
