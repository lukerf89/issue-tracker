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
  limit?: number;
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
  cursor: string;
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

export function listActivitySince(
  context: ServiceContext,
  input: ListActivitySinceInput = {}
): ActivityFeed {
  const cursor = normalizeCursor(input.cursor);
  const limit = input.limit ?? 100;
  const rowid = sql<number>`${activity}.rowid`;
  const conditions: SQL[] = [gt(rowid, cursor)];

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
    .where(and(...conditions))
    .orderBy(rowid)
    .limit(limit)
    .all();

  const events = rows.map(({ cursor: eventCursor, entry, actor, issue }) => ({
    ...entry,
    data: parseActivityData(entry.data),
    actor,
    issue,
    issueIdentifier: issue.identifier,
    cursor: String(eventCursor)
  }));

  return {
    events,
    cursor: events.at(-1)?.cursor ?? String(cursor)
  };
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

function normalizeCursor(cursor: ListActivitySinceInput["cursor"]): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const parsed = typeof cursor === "number" ? cursor : Number.parseInt(cursor, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== String(cursor)) {
    throw new AppError(
      AppErrorCode.VALIDATION_FAILED,
      `Activity cursor ${String(cursor)} is not valid.`,
      { cursor }
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
