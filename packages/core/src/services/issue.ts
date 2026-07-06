import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { actors, issueLabels, issues, labels, projects, teams, workflowStates, type Actor, type Attachment, type Issue } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { identifier, uuid } from "../ids.js";
import { appendActivityInTransaction } from "./activity.js";
import { ConfigKey, getConfig } from "./config.js";
import {
  cycleIdsForIssueFilter,
  resolveOptionalCycleId,
  type CycleRef
} from "./cycle.js";
import {
  attachLabelInTransaction,
  detachLabelInTransaction,
  resolveIssueLabels,
  withIssueLabels,
  type IssueWithLabels
} from "./label.js";
import { listAttachments } from "./attachment.js";
import { listComments, type CommentWithAuthor } from "./comment.js";
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
  cycle?: CycleRef | null;
  cycleId?: string | null;
  parent?: string | null;
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
  cycle?: CycleRef;
  limit?: number;
  includeArchived?: boolean;
}

export interface SearchIssuesInput extends ListIssueFilters {
  query: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  priority?: number;
  assignee?: string | null;
  assigneeId?: string | null;
  project?: string | null;
  projectId?: string | null;
  cycle?: CycleRef | null;
  cycleId?: string | null;
  parent?: string | null;
  parentId?: string | null;
  estimate?: number | null;
  dueDate?: string | null;
  sortOrder?: number;
  labels?: string[];
  removeLabels?: string[];
}

export interface AssignIssueInput {
  identifier: string;
  actor: string | null;
}

export interface ArchiveIssueInput {
  identifier: string;
}

export interface UnarchiveIssueInput {
  identifier: string;
}

export interface IssueReference {
  id: string;
  identifier: string;
  teamId: string;
  number: number;
  title: string;
}

export type IssueWithDetails = IssueWithLabels & {
  parent: IssueReference | null;
  children: IssueReference[];
  comments: CommentWithAuthor[];
  attachments: Attachment[];
};

export function createIssue(context: ServiceContext, input: CreateIssueInput) {
  requireActor(context);

  return inTransaction(context, (txContext) => {
    const team = resolveTeam(txContext, input.teamId ?? input.team);
    const state = input.stateId ?? input.state
      ? getState(txContext, input.stateId ?? input.state ?? "", team.id)
      : resolveDefaultUnstartedState(txContext, team.id);
    const assigneeId = resolveOptionalActorId(txContext, input.assigneeId ?? input.assignee);
    const projectId = resolveOptionalProjectId(txContext, input.projectId ?? input.project);
    const cycleId = resolveOptionalCycleId(
      txContext,
      input.cycleId ?? input.cycle,
      team.id
    );
    const parentId = resolveOptionalParentId(txContext, parentInput(input));
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
      cycleId,
      parentId,
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
    appendActivityInTransaction(txContext, {
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

  return withIssueDetails(context, issue);
}

export function listIssues(context: ServiceContext, filters: ListIssueFilters = {}) {
  const conditions = issueFilterConditions(context, filters);

  if (conditions === null) {
    return [];
  }

  return context.db
    .select({ issue: issues })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(teams.key), asc(issues.number), asc(issues.id))
    .limit(filters.limit ?? -1)
    .all()
    .map(({ issue }) => withIssueDetails(context, issue));
}

export function searchIssues(context: ServiceContext, input: SearchIssuesInput) {
  const filterConditions = issueFilterConditions(context, input);

  if (filterConditions === null) {
    return [];
  }

  const conditions: SQL[] = [...filterConditions, textSearchCondition(input.query)];

  return context.db
    .select({ issue: issues })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .where(and(...conditions))
    .orderBy(asc(teams.key), asc(issues.number), asc(issues.id))
    .limit(input.limit ?? -1)
    .all()
    .map(({ issue }) => withIssueDetails(context, issue));
}

function issueFilterConditions(
  context: ServiceContext,
  filters: ListIssueFilters
): SQL[] | null {
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
      return null;
    }

    conditions.push(inArray(issues.id, issueIds));
  }

  if (filters.cycle !== undefined) {
    const cycleIds = cycleIdsForIssueFilter(context, filters.cycle, filters.team);

    if (cycleIds.length === 0) {
      return null;
    }

    conditions.push(inArray(issues.cycleId, cycleIds));
  }

  return conditions;
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
    if (has(input, "cycle") || has(input, "cycleId")) {
      addChange(
        changes,
        changedFields,
        "cycleId",
        resolveOptionalCycleId(
          txContext,
          has(input, "cycleId") ? input.cycleId : input.cycle,
          issue.teamId
        )
      );
    }
    if (has(input, "parent") || has(input, "parentId")) {
      const parentId = resolveOptionalParentId(
        txContext,
        has(input, "parentId") ? input.parentId : input.parent
      );
      assertValidParent(txContext, issue, parentId);
      addChange(changes, changedFields, "parentId", parentId);
    }
    if (has(input, "estimate")) addChange(changes, changedFields, "estimate", input.estimate ?? null);
    if (has(input, "dueDate")) addChange(changes, changedFields, "dueDate", input.dueDate ?? null);
    if (has(input, "sortOrder")) addChange(changes, changedFields, "sortOrder", input.sortOrder!);

    if (Object.keys(changedFields).length > 0) {
      txContext.db.update(issues).set(changes).where(eq(issues.id, issue.id)).run();
      appendActivityInTransaction(txContext, {
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

export function assignIssue(
  context: ServiceContext,
  issueIdentifier: string,
  actorRef: string | null
) {
  requireActor(context);

  return inTransaction(context, (txContext) => {
    const issue = getIssueByIdOrIdentifier(txContext, issueIdentifier);
    const assignee = resolveOptionalActor(txContext, actorRef);
    const previousAssignee = issue.assigneeId ? getActorById(txContext, issue.assigneeId) : null;
    const assigneeId = assignee?.id ?? null;

    if (issue.assigneeId !== assigneeId) {
      const now = txContext.clock.now().toISOString();

      txContext.db
        .update(issues)
        .set({
          assigneeId,
          updatedAt: now
        })
        .where(eq(issues.id, issue.id))
        .run();

      appendActivityInTransaction(txContext, {
        issueId: issue.id,
        actorId: requireActor(txContext).id,
        action: "assigned",
        data: {
          from: previousAssignee?.id ?? null,
          to: assignee?.id ?? null,
          fromHandle: previousAssignee?.handle ?? null,
          toHandle: assignee?.handle ?? null
        }
      });
    }

    return getIssue(txContext, issue.identifier);
  });
}

export function archiveIssue(context: ServiceContext, issueIdentifier: string) {
  requireActor(context);

  return inTransaction(context, (txContext) => {
    const issue = getIssueByIdOrIdentifier(txContext, issueIdentifier);

    if (issue.archivedAt !== null) {
      return getIssue(txContext, issue.identifier);
    }

    const now = txContext.clock.now().toISOString();

    txContext.db
      .update(issues)
      .set({
        archivedAt: now,
        updatedAt: now
      })
      .where(eq(issues.id, issue.id))
      .run();

    appendActivityInTransaction(txContext, {
      issueId: issue.id,
      actorId: requireActor(txContext).id,
      action: "archived",
      data: { identifier: issue.identifier }
    });

    return getIssue(txContext, issue.identifier);
  });
}

export function unarchiveIssue(context: ServiceContext, issueIdentifier: string) {
  requireActor(context);

  return inTransaction(context, (txContext) => {
    const issue = getIssueByIdOrIdentifier(txContext, issueIdentifier);

    if (issue.archivedAt === null) {
      throw new AppError(
        AppErrorCode.CONSTRAINT_VIOLATION,
        `Issue ${issue.identifier} is not archived.`,
        { identifier: issue.identifier }
      );
    }

    const now = txContext.clock.now().toISOString();

    txContext.db
      .update(issues)
      .set({
        archivedAt: null,
        updatedAt: now
      })
      .where(eq(issues.id, issue.id))
      .run();

    appendActivityInTransaction(txContext, {
      issueId: issue.id,
      actorId: requireActor(txContext).id,
      action: "unarchived",
      data: { identifier: issue.identifier }
    });

    return getIssue(txContext, issue.identifier);
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

    appendActivityInTransaction(txContext, {
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

function withIssueDetails(context: ServiceContext, issue: Issue): IssueWithDetails {
  return {
    ...withIssueLabels(context, issue),
    parent: issue.parentId ? issueReference(getIssueById(context, issue.parentId)) : null,
    children: listChildIssueReferences(context, issue.id),
    comments: listComments(context, { issue: issue.id }),
    attachments: listAttachments(context, { issue: issue.id })
  };
}

function listChildIssueReferences(context: ServiceContext, parentId: string): IssueReference[] {
  return context.db.query.issues.findMany({
    where: eq(issues.parentId, parentId),
    orderBy: [asc(issues.teamId), asc(issues.number), asc(issues.id)]
  }).sync().map(issueReference);
}

function resolveOptionalParentId(
  context: ServiceContext,
  parentRef: string | null | undefined
): string | null {
  return parentRef == null ? null : getIssueByIdOrIdentifier(context, parentRef).id;
}

function assertValidParent(
  context: ServiceContext,
  issue: Issue,
  parentId: string | null
): void {
  if (parentId === null) return;

  let current = getIssueById(context, parentId);
  const seen = new Set<string>();

  while (true) {
    if (current.id === issue.id) {
      throw new AppError(
        AppErrorCode.ISSUE_PARENT_CYCLE,
        `Parent ${parentId} would create a cycle for issue ${issue.identifier}.`,
        {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          parentId
        }
      );
    }

    if (current.parentId === null) {
      return;
    }

    if (seen.has(current.id)) {
      throw new AppError(
        AppErrorCode.ISSUE_PARENT_CYCLE,
        `Existing parent chain for issue ${current.identifier} contains a cycle.`,
        {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          parentId
        }
      );
    }

    seen.add(current.id);
    current = getIssueById(context, current.parentId);
  }
}

function getIssueByIdOrIdentifier(context: ServiceContext, idOrIdentifier: string): Issue {
  return findIssueByIdOrIdentifier(context, idOrIdentifier) ?? notFound(idOrIdentifier);
}

function getIssueById(context: ServiceContext, id: string): Issue {
  const issue = context.db.query.issues.findFirst({
    where: eq(issues.id, id)
  }).sync();

  return issue ?? notFound(id);
}

function findIssueByIdOrIdentifier(context: ServiceContext, idOrIdentifier: string): Issue | null {
  return (
    context.db.query.issues.findFirst({ where: eq(issues.id, idOrIdentifier) }).sync() ??
    context.db.query.issues.findFirst({ where: eq(issues.identifier, idOrIdentifier) }).sync() ??
    null
  );
}

function notFound(identifier: string): never {
  throw new AppError(
    AppErrorCode.ISSUE_NOT_FOUND,
    `Issue ${identifier} was not found.`,
    { identifier }
  );
}

function issueReference(issue: Issue): IssueReference {
  return {
    id: issue.id,
    identifier: issue.identifier,
    teamId: issue.teamId,
    number: issue.number,
    title: issue.title
  };
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

function textSearchCondition(query: string): SQL {
  const pattern = `%${escapeLike(query.toLowerCase())}%`;

  return sql`(
    lower(${issues.title}) like ${pattern} escape '\\'
    or lower(coalesce(${issues.description}, '')) like ${pattern} escape '\\'
  )`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
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
  return resolveActor(context, actorRef).id;
}

function resolveOptionalActor(
  context: ServiceContext,
  actorRef: string | null | undefined
): Actor | null {
  return actorRef == null ? null : resolveActor(context, actorRef);
}

function resolveActor(context: ServiceContext, actorRef: string): Actor {
  const actor =
    context.db.query.actors.findFirst({ where: eq(actors.id, actorRef) }).sync() ??
    context.db.query.actors.findFirst({ where: eq(actors.handle, actorRef) }).sync();

  if (!actor) {
    throw new AppError(AppErrorCode.ACTOR_NOT_FOUND, `Actor ${actorRef} was not found.`, {
      actor: actorRef
    });
  }

  return actor;
}

function getActorById(context: ServiceContext, id: string): Actor {
  const actor = context.db.query.actors.findFirst({
    where: eq(actors.id, id)
  }).sync();

  if (!actor) {
    throw new AppError(AppErrorCode.ACTOR_NOT_FOUND, `Actor ${id} was not found.`, {
      actor: id
    });
  }

  return actor;
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

function parentInput(input: CreateIssueInput): string | null | undefined {
  return has(input, "parentId") ? input.parentId : input.parent;
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
