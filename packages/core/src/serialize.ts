import type { Activity, Actor, Issue, Project, Team, WorkflowState } from "./db/schema.js";

export function serializeTeam(team: Team) {
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    issueCounter: team.issueCounter,
    archivedAt: toIsoOrNull(team.archivedAt)
  };
}

export function serializeWorkflowState(state: WorkflowState) {
  return {
    id: state.id,
    teamId: state.teamId,
    name: state.name,
    type: state.type,
    color: state.color,
    position: state.position
  };
}

export function serializeActor(actor: Actor) {
  return {
    id: actor.id,
    type: actor.type,
    name: actor.name,
    handle: actor.handle,
    archivedAt: toIsoOrNull(actor.archivedAt)
  };
}

export function serializeProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    status: project.status,
    leadId: project.leadId ?? null,
    startDate: project.startDate ?? null,
    targetDate: project.targetDate ?? null,
    archivedAt: toIsoOrNull(project.archivedAt)
  };
}

export function serializeIssue(issue: Issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    teamId: issue.teamId,
    number: issue.number,
    title: issue.title,
    description: issue.description ?? null,
    stateId: issue.stateId,
    priority: issue.priority,
    assigneeId: issue.assigneeId ?? null,
    creatorId: issue.creatorId,
    projectId: issue.projectId ?? null,
    cycleId: issue.cycleId ?? null,
    parentId: issue.parentId ?? null,
    estimate: issue.estimate ?? null,
    dueDate: issue.dueDate ?? null,
    sortOrder: issue.sortOrder,
    createdAt: toIso(issue.createdAt),
    updatedAt: toIso(issue.updatedAt),
    startedAt: toIsoOrNull(issue.startedAt),
    completedAt: toIsoOrNull(issue.completedAt),
    canceledAt: toIsoOrNull(issue.canceledAt),
    archivedAt: toIsoOrNull(issue.archivedAt)
  };
}

export function serializeActivity(entry: Activity) {
  return {
    id: entry.id,
    issueId: entry.issueId,
    actorId: entry.actorId,
    action: entry.action,
    data: entry.data,
    createdAt: toIso(entry.createdAt)
  };
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: string | null): string | null {
  return value === null ? null : toIso(value);
}
