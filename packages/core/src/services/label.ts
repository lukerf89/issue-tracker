import { and, asc, eq, isNull } from "drizzle-orm";

import { inTransaction, type ServiceContext, type ServiceTransaction } from "../context.js";
import { issueLabels, issues, labels, type Issue, type Label } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { appendActivity } from "./activity.js";

export interface CreateLabelInput {
  name: string;
  color?: string;
  group?: string | null;
}

export interface ListLabelsOptions {
  includeArchived?: boolean;
}

export type IssueWithLabels = Issue & { labels: Label[] };

const defaultLabelColor = "#6B7280";

export function createLabel(context: ServiceContext, input: CreateLabelInput) {
  const group = input.group ?? null;
  const existing = context.db.query.labels.findFirst({
    where: and(eq(labels.name, input.name), eq(labels.groupKey, groupKey(group)))
  }).sync();

  if (existing) {
    throw new AppError(
      AppErrorCode.CONSTRAINT_VIOLATION,
      labelTakenMessage(input.name, group),
      { name: input.name, group }
    );
  }

  const row = {
    id: uuid(),
    name: input.name,
    color: input.color ?? defaultLabelColor,
    group,
    archivedAt: null
  };

  context.db.insert(labels).values(row).run();
  return getLabelById(context, row.id);
}

export function listLabels(
  context: ServiceContext,
  options: ListLabelsOptions = {}
) {
  return context.db.query.labels.findMany({
    where: options.includeArchived ? undefined : isNull(labels.archivedAt),
    orderBy: [asc(labels.groupKey), asc(labels.name), asc(labels.id)]
  }).sync();
}

export function getLabel(context: ServiceContext, idOrName: string) {
  const label = findLabel(context, idOrName, { includeArchived: false });

  if (!label) {
    throw new AppError(
      AppErrorCode.LABEL_NOT_FOUND,
      `Label ${idOrName} was not found.`,
      { label: idOrName }
    );
  }

  return label;
}

export function archiveLabel(context: ServiceContext, idOrName: string) {
  return inTransaction(context, (txContext) => {
    const label = getLabelForArchive(txContext, idOrName);

    if (label.archivedAt !== null) {
      return label;
    }

    txContext.db
      .update(labels)
      .set({ archivedAt: txContext.clock.now().toISOString() })
      .where(eq(labels.id, label.id))
      .run();

    return getLabelById(txContext, label.id);
  });
}

export function attachLabel(context: ServiceContext, issueId: string, labelId: string) {
  requireActor(context);
  return inTransaction(context, (txContext) => attachLabelInTransaction(txContext, issueId, labelId));
}

export function detachLabel(context: ServiceContext, issueId: string, labelId: string) {
  requireActor(context);
  return inTransaction(context, (txContext) => detachLabelInTransaction(txContext, issueId, labelId));
}

export function attachLabelInTransaction(
  context: ServiceContext & { db: ServiceTransaction },
  issueId: string,
  labelId: string
) {
  const actor = requireActor(context);
  const issue = getIssueById(context, issueId);
  const label = getActiveLabelById(context, labelId);

  const existing = context.db.query.issueLabels.findFirst({
    where: and(eq(issueLabels.issueId, issue.id), eq(issueLabels.labelId, label.id))
  }).sync();

  if (existing) {
    return label;
  }

  context.db.insert(issueLabels).values({ issueId: issue.id, labelId: label.id }).run();
  touchIssue(context, issue.id);
  appendActivity(context, {
    issueId: issue.id,
    actorId: actor.id,
    action: "label_added",
    data: { labelId: label.id, labelName: label.name }
  });

  return label;
}

export function detachLabelInTransaction(
  context: ServiceContext & { db: ServiceTransaction },
  issueId: string,
  labelId: string
) {
  const actor = requireActor(context);
  const issue = getIssueById(context, issueId);
  const label = getLabelById(context, labelId);

  const existing = context.db.query.issueLabels.findFirst({
    where: and(eq(issueLabels.issueId, issue.id), eq(issueLabels.labelId, label.id))
  }).sync();

  if (!existing) {
    return label;
  }

  context.db
    .delete(issueLabels)
    .where(and(eq(issueLabels.issueId, issue.id), eq(issueLabels.labelId, label.id)))
    .run();
  touchIssue(context, issue.id);
  appendActivity(context, {
    issueId: issue.id,
    actorId: actor.id,
    action: "label_removed",
    data: { labelId: label.id, labelName: label.name }
  });

  return label;
}

export function resolveIssueLabels(context: ServiceContext, refs: string[] | undefined): Label[] {
  if (!refs || refs.length === 0) {
    return [];
  }

  const resolved: Label[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const label = getLabel(context, ref);

    if (!seen.has(label.id)) {
      seen.add(label.id);
      resolved.push(label);
    }
  }

  return resolved;
}

export function listIssueLabels(context: ServiceContext, issueId: string) {
  return context.db
    .select({
      id: labels.id,
      name: labels.name,
      color: labels.color,
      group: labels.group,
      groupKey: labels.groupKey,
      archivedAt: labels.archivedAt
    })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(and(eq(issueLabels.issueId, issueId), isNull(labels.archivedAt)))
    .orderBy(asc(labels.groupKey), asc(labels.name), asc(labels.id))
    .all();
}

export function withIssueLabels(context: ServiceContext, issue: Issue): IssueWithLabels {
  return {
    ...issue,
    labels: listIssueLabels(context, issue.id)
  };
}

function getLabelForArchive(context: ServiceContext, idOrName: string) {
  const label = findLabel(context, idOrName, { includeArchived: true });

  if (!label) {
    throw new AppError(
      AppErrorCode.LABEL_NOT_FOUND,
      `Label ${idOrName} was not found.`,
      { label: idOrName }
    );
  }

  return label;
}

function findLabel(
  context: ServiceContext,
  idOrName: string,
  options: { includeArchived: boolean }
) {
  const byId = context.db.query.labels.findFirst({
    where: options.includeArchived
      ? eq(labels.id, idOrName)
      : and(eq(labels.id, idOrName), isNull(labels.archivedAt))
  }).sync();

  if (byId) {
    return byId;
  }

  const conditions = [eq(labels.name, idOrName)];
  if (!options.includeArchived) {
    conditions.push(isNull(labels.archivedAt));
  }

  const matches = context.db.query.labels.findMany({
    where: and(...conditions),
    orderBy: [asc(labels.groupKey), asc(labels.id)]
  }).sync();

  if (matches.length > 1) {
    throw new AppError(
      AppErrorCode.CONSTRAINT_VIOLATION,
      `Label ${idOrName} is ambiguous; use its id.`,
      { label: idOrName, ids: matches.map((label) => label.id) }
    );
  }

  return matches[0] ?? null;
}

function getLabelById(context: ServiceContext, id: string) {
  const label = context.db.query.labels.findFirst({
    where: eq(labels.id, id)
  }).sync();

  if (!label) {
    throw new AppError(
      AppErrorCode.LABEL_NOT_FOUND,
      `Label ${id} was not found.`,
      { label: id }
    );
  }

  return label;
}

function getActiveLabelById(context: ServiceContext, id: string) {
  const label = getLabelById(context, id);

  if (label.archivedAt !== null) {
    throw new AppError(
      AppErrorCode.LABEL_NOT_FOUND,
      `Label ${id} was not found.`,
      { label: id }
    );
  }

  return label;
}

function getIssueById(context: ServiceContext, id: string) {
  const issue = context.db.query.issues.findFirst({
    where: eq(issues.id, id)
  }).sync();

  if (!issue) {
    throw new AppError(AppErrorCode.ISSUE_NOT_FOUND, `Issue ${id} was not found.`, {
      id
    });
  }

  return issue;
}

function touchIssue(context: ServiceContext, issueId: string): void {
  context.db
    .update(issues)
    .set({ updatedAt: context.clock.now().toISOString() })
    .where(eq(issues.id, issueId))
    .run();
}

function groupKey(group: string | null): string {
  return group ?? "";
}

function labelTakenMessage(name: string, group: string | null): string {
  if (group === null) {
    return `Label ${name} already exists without a group.`;
  }

  return `Label ${name} already exists in group ${group}.`;
}

function requireActor(context: ServiceContext) {
  if (!context.actor) {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      "A service actor is required for this mutation."
    );
  }

  return context.actor;
}
