import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { actors, issueLabels, issues, labels, projects, teams, workflowStates, type Issue } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { identifier, uuid } from "../ids.js";
import { appendActivity } from "./activity.js";
import { ConfigKey, getConfig } from "./config.js";
import {
  attachLabelInTransaction,
  detachLabelInTransaction,
  resolveIssueLabels,
  withIssueLabels
} from "./label.js";
import { getState, resolveDefaultUnstartedState } from "./state.js";
import { getTeam, getTeamByKey } from "./team.js";

export interface CreateIssueInput {
  title: string;
  description?: string | null;
  team?: string;
  teamId?: string;
  state?: string;
  stateId?: string;
  priority?: number;
  assignee?: string | null;
  assigneeId?: string | null;
  project?: string | null;
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  estimate?: number | null;
  dueDate?: string | null;
  sortOrder?: number;
  labels?: string[];
}

export interface ListIssueFilters {
  state?: string;
  assignee?: string | null;
  project?: string | null;
  team?: string;
  priority?: number;
  label?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  priority?: number;
  assignee?: string | null;
  assigneeId?: string | null;
  project?: string | null;
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  estimate?: number | null;
  dueDate?: string | null;
  sortOrder?: number;
  labels?: string[];
  removeLabels?: string[];
}

export function createIssue(context: ServiceContext, input: CreateIssueInput) {
  requireActor(context);

  return inTransaction(context, (txContext) => {
    const team = resolveTeam(txContext, input.teamId ?? input.team);
    const state = input.stateId ?? input.state
      ? getState(txContext, input.stateId ?? input.state ?? "", team.id)
      : resolveDefaultUnstartedState(txContext, team.id);
    const assigneeId = resolveOptionalActorId(txContext, input.assigneeId ?? input.assignee);
    const projectId = resolveOptionalProjectId(txContext, input.projectId ?? input.project);
    const labelRows = resolveIssueLabels(txContext, input.labels);

    txContext.db
      .update(teams)
      .set({ issueCounter: sql`${teams.issueCounter} + 1` })
      .where(eq(teams.id, team.id))
      .run();

    const updatedTeam = getTeam(txContext, team.id);
    const number = updatedTeam.issueCounter;
    const now = txContext.clock.now().toISOString();
    const row = {
      id: uuid(),
      identifier: identifier(updatedTeam.key, number),
      teamId: updatedTeam.id,
      number,
      title: input.title,
      description: input.description ?? null,
      stateId: state.id,
      priority: input.priority ?? 0,
      assigneeId,
      creatorId: requireActor(txContext).id,
      projectId,
      cycleId: input.cycleId ?? null,
      parentId: input.parentId ?? null,
      estimate: input.estimate ?? null,
      dueDate: input.dueDate ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null
    };

    txContext.db.insert(issues).values(row).run();
    appendActivity(txContext, {
      issueId: row.id,
      actorId: row.creatorId,
      action: "created",
      data: { identifier: row.identifier }
    });

    for (const label of labelRows) {
      attachLabelInTransaction(txContext, row.id, label.id);
    }

    return getIssue(txContext, row.identifier);
  });
}

export function getIssue(context: ServiceContext, issueIdentifier: string) {
  const issue = context.db.query.issues.findFirst({
    where: eq(issues.identifier, issueIdentifier)
  }).sync();

  if (!issue) {
    throw new AppError(
      AppErrorCode.ISSUE_NOT_FOUND,
      `Issue ${issueIdentifier} was not found.`,
      { identifier: issueIdentifier }
    );
  }

  return withIssueLabels(context, issue);
}

export function listIssues(context: ServiceContext, filters: ListIssueFilters = {}) {
  const conditions: SQL[] = [];

  if (!filters.includeArchived) {
    conditions.push(isNull(issues.archivedAt));
  }

  if (filters.team) {
    conditions.push(eq(issues.teamId, resolveTeam(context, filters.team).id));
  }

  if (filters.state) {
    conditions.push(stateFilterCondition(context, filters.state, filters.team));
  }

  if (filters.assignee !== undefined) {
    conditions.push(
      filters.assignee === null
        ? isNull(issues.assigneeId)
        : eq(issues.assigneeId, resolveActorId(context, filters.assignee))
    );
  }

  if (filters.project !== undefined) {
    conditions.push(
      filters.project === null
        ? isNull(issues.projectId)
        : eq(issues.projectId, resolveProjectId(context, filters.project))
    );
  }

  if (filters.priority !== undefined) {
    conditions.push(eq(issues.priority, filters.priority));
  }

  if (filters.label) {
    const issueIds = issueIdsForLabelName(context, filters.label);

    if (issueIds.length === 0) {
      return [];
    }

    conditions.push(inArray(issues.id, issueIds));
  }

  return context.db.query.issues.findMany({
    where: conditions.length ? and(...conditions) : undefined,
    orderBy: [asc(issues.teamId), asc(issues.number)],
    limit: filters.limit
  }).sync().map((issue) => withIssueLabels(context, issue));
}

export function updateIssue(context: ServiceContext, issueIdentifier: string, input: UpdateIssueInput) {
  requireActor(context);

  return inTransaction(context, (txContext) => {
    const issue = getIssue(txContext, issueIdentifier);
    const now = txContext.clock.now().toISOString();
    const changes: Partial<typeof issues.$inferInsert> = { updatedAt: now };
    const changedFields: Record<string, unknown> = {};
    const addLabels = resolveIssueLabels(txContext, input.labels);
    const removeLabels = resolveIssueLabels(txContext, input.removeLabels);
    assertNoLabelOverlap(addLabels, removeLabels);

    if (has(input, "title")) addChange(changes, changedFields, "title", input.title!);
    if (has(input, "description")) {
      addChange(changes, changedFields, "description", input.description ?? null);
    }
    if (has(input, "priority")) addChange(changes, changedFields, "priority", input.priority!);
    if (has(input, "assignee") || has(input, "assigneeId")) {
      addChange(
        changes,
        changedFields,
        "assigneeId",
        resolveOptionalActorId(txContext, input.assigneeId ?? input.assignee)
      );
    }
    if (has(input, "project") || has(input, "projectId")) {
      addChange(
        changes,
        changedFields,
        "projectId",
        resolveOptionalProjectId(txContext, input.projectId ?? input.project)
      );
    }
    if (has(input, "cycleId")) addChange(changes, changedFields, "cycleId", input.cycleId ?? null);
    if (has(input, "parentId")) addChange(changes, changedFields, "parentId", input.parentId ?? null);
    if (has(input, "estimate")) addChange(changes, changedFields, "estimate", input.estimate ?? null);
    if (has(input, "dueDate")) addChange(changes, changedFields, "dueDate", input.dueDate ?? null);
    if (has(input, "sortOrder")) addChange(changes, changedFields, "sortOrder", input.sortOrder!);

    if (Object.keys(changedFields).length > 0) {
      txContext.db.update(issues).set(changes).where(eq(issues.id, issue.id)).run();
      appendActivity(txContext, {
        issueId: issue.id,
        actorId: requireActor(txContext).id,
        action: "updated",
        data: { changed: changedFields }
      });
    }

    for (const label of removeLabels) {
      detachLabelInTransaction(txContext, issue.id, label.id);
    }

    for (const label of addLabels) {
      attachLabelInTransaction(txContext, issue.id, label.id);
    }

    return getIssue(txContext, issueIdentifier);
  });
}

export function moveIssue(context: ServiceContext, issueIdentifier: string, stateIdOrName: string) {
  requireActor(context);

  return inTransaction(context, (txContext) => {
    const issue = getIssue(txContext, issueIdentifier);
    const previousState = getState(txContext, issue.stateId, issue.teamId);
    const nextState = getState(txContext, stateIdOrName, issue.teamId);
    const changes = lifecycleTimestampChanges(issue, previousState.type, nextState.type, txContext.clock.now());

    txContext.db
      .update(issues)
      .set({
        stateId: nextState.id,
        updatedAt: changes.updatedAt,
        startedAt: changes.startedAt,
        completedAt: changes.completedAt,
        canceledAt: changes.canceledAt
      })
      .where(eq(issues.id, issue.id))
      .run();

    appendActivity(txContext, {
      issueId: issue.id,
      actorId: requireActor(txContext).id,
      action: "state_changed",
      data: {
        from: previousState.id,
        to: nextState.id,
        fromName: previousState.name,
        toName: nextState.name
      }
    });

    return getIssue(txContext, issueIdentifier);
  });
}

function lifecycleTimestampChanges(
  issue: Issue,
  previousType: string,
  nextType: string,
  nowDate: Date
) {
  const now = nowDate.toISOString();
  const wasTerminal = previousType === "completed" || previousType === "canceled";
  let startedAt = issue.startedAt;
  let completedAt = issue.completedAt;
  let canceledAt = issue.canceledAt;

  if (wasTerminal && nextType !== previousType) {
    completedAt = null;
    canceledAt = null;
  }

  if (nextType === "started") {
    startedAt = wasTerminal ? now : startedAt ?? now;
  }

  if (nextType === "completed") {
    completedAt = now;
    canceledAt = null;
  }

  if (nextType === "canceled") {
    canceledAt = now;
    completedAt = null;
  }

  return { updatedAt: now, startedAt, completedAt, canceledAt };
}

function issueIdsForLabelName(context: ServiceContext, labelName: string): string[] {
  return context.db
    .select({ issueId: issueLabels.issueId })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(and(eq(labels.name, labelName), isNull(labels.archivedAt)))
    .all()
    .map((row) => row.issueId);
}

function resolveTeam(context: ServiceContext, idOrKey?: string) {
  const teamRef = idOrKey ?? getConfig(context, ConfigKey.DEFAULT_TEAM);

  if (!teamRef) {
    throw new AppError(
      AppErrorCode.TEAM_NOT_FOUND,
      "Default team is not configured.",
      { key: ConfigKey.DEFAULT_TEAM }
    );
  }

  const byId = context.db.query.teams.findFirst({
    where: eq(teams.id, teamRef)
  }).sync();

  return byId ?? getTeamByKey(context, teamRef);
}

function resolveStateForFilter(context: ServiceContext, stateRef: string, teamRef?: string) {
  const byId = context.db.query.workflowStates.findFirst({
    where: eq(workflowStates.id, stateRef)
  }).sync();

  if (byId) {
    return byId;
  }

  const teamId = teamRef ? resolveTeam(context, teamRef).id : undefined;
  return getState(context, stateRef, teamId);
}

function stateFilterCondition(context: ServiceContext, stateRef: string, teamRef?: string): SQL {
  if (teamRef) {
    const state = resolveStateForFilter(context, stateRef, teamRef);
    return eq(issues.stateId, state.id);
  }

  const byId = context.db.query.workflowStates.findFirst({
    where: eq(workflowStates.id, stateRef)
  }).sync();

  if (byId) {
    return eq(issues.stateId, byId.id);
  }

  const statesByName = context.db.query.workflowStates.findMany({
    where: eq(workflowStates.name, stateRef)
  }).sync();

  if (statesByName.length === 0) {
    throw new AppError(
      AppErrorCode.WORKFLOW_STATE_NOT_FOUND,
      `Workflow state ${stateRef} was not found.`,
      { state: stateRef, teamId: null }
    );
  }

  return inArray(issues.stateId, statesByName.map((state) => state.id));
}

function resolveOptionalActorId(context: ServiceContext, actorRef: string | null | undefined) {
  return actorRef == null ? null : resolveActorId(context, actorRef);
}

function resolveActorId(context: ServiceContext, actorRef: string) {
  const actor =
    context.db.query.actors.findFirst({ where: eq(actors.id, actorRef) }).sync() ??
    context.db.query.actors.findFirst({ where: eq(actors.handle, actorRef) }).sync();

  if (!actor) {
    throw new AppError(AppErrorCode.ACTOR_NOT_FOUND, `Actor ${actorRef} was not found.`, {
      actor: actorRef
    });
  }

  return actor.id;
}

function resolveOptionalProjectId(context: ServiceContext, projectRef: string | null | undefined) {
  return projectRef == null ? null : resolveProjectId(context, projectRef);
}

function resolveProjectId(context: ServiceContext, projectRef: string) {
  const project =
    context.db.query.projects.findFirst({ where: eq(projects.id, projectRef) }).sync() ??
    context.db.query.projects.findFirst({ where: eq(projects.name, projectRef) }).sync();

  if (!project) {
    throw new AppError(
      AppErrorCode.PROJECT_NOT_FOUND,
      `Project ${projectRef} was not found.`,
      { project: projectRef }
    );
  }

  return project.id;
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

function addChange<T extends keyof typeof issues.$inferInsert>(
  changes: Partial<typeof issues.$inferInsert>,
  changedFields: Record<string, unknown>,
  key: T,
  value: (typeof issues.$inferInsert)[T]
): void {
  changes[key] = value;
  changedFields[key] = value ?? null;
}

function assertNoLabelOverlap(addLabels: Array<{ id: string }>, removeLabels: Array<{ id: string }>) {
  const addedIds = new Set(addLabels.map((label) => label.id));
  const overlap = removeLabels.find((label) => addedIds.has(label.id));

  if (overlap) {
    throw new AppError(
      AppErrorCode.CONSTRAINT_VIOLATION,
      "A label cannot be added and removed in the same update.",
      { labelId: overlap.id }
    );
  }
}

function has<T extends object>(object: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
