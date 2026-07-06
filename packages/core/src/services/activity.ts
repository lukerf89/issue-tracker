import { asc, eq, sql } from "drizzle-orm";

import { inTransaction, type ServiceContext, type ServiceTransaction } from "../context.js";
import { actors, activity, issues, type Activity, type Actor, type Issue } from "../db/schema.js";
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

export type ActivityWithActor = Activity & { actor: Actor };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
