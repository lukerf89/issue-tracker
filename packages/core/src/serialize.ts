import type { Activity, Actor, Attachment, Comment, Cycle, Issue, Label, Project, Team, WorkflowState } from "./db/schema.js";
import type { ActivityFeedEvent } from "./services/activity.js";
import type { SavedViewWithFilters } from "./services/savedView.js";
import type { TemplateWithLabels } from "./services/template.js";

interface IssueReference {
  id: string;
  identifier: string;
  teamId: string;
  number: number;
  title: string;
}

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

export function serializeCycle(cycle: Cycle) {
  return {
    id: cycle.id,
    teamId: cycle.teamId,
    number: cycle.number,
    name: cycle.name ?? null,
    startsAt: toIso(cycle.startsAt),
    endsAt: toIso(cycle.endsAt)
  };
}

export function serializeLabel(label: Label) {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    group: label.group ?? null,
    archivedAt: toIsoOrNull(label.archivedAt)
  };
}

export function serializeIssue(
  issue: Issue & {
    labels?: Label[];
    parent?: IssueReference | null;
    children?: IssueReference[];
    comments?: Array<Comment & { author: Actor }>;
    attachments?: Attachment[];
  }
) {
  const relationFields = {
    ...(hasOwn(issue, "parent")
      ? { parent: issue.parent ? serializeIssueReference(issue.parent) : null }
      : {}),
    ...(hasOwn(issue, "children")
      ? { children: (issue.children ?? []).map(serializeIssueReference) }
      : {}),
    ...(hasOwn(issue, "comments")
      ? { comments: (issue.comments ?? []).map(serializeComment) }
      : {}),
    ...(hasOwn(issue, "attachments")
      ? { attachments: (issue.attachments ?? []).map(serializeAttachment) }
      : {})
  };

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
    ...relationFields,
    estimate: issue.estimate ?? null,
    dueDate: issue.dueDate ?? null,
    sortOrder: issue.sortOrder,
    createdAt: toIso(issue.createdAt),
    updatedAt: toIso(issue.updatedAt),
    startedAt: toIsoOrNull(issue.startedAt),
    completedAt: toIsoOrNull(issue.completedAt),
    canceledAt: toIsoOrNull(issue.canceledAt),
    archivedAt: toIsoOrNull(issue.archivedAt),
    labels: (issue.labels ?? []).map(serializeLabel)
  };
}

export function serializeComment(comment: Comment & { author: Actor }) {
  return {
    id: comment.id,
    issueId: comment.issueId,
    authorId: comment.authorId,
    author: serializeActor(comment.author),
    body: comment.body,
    parentId: comment.parentId ?? null,
    createdAt: toIso(comment.createdAt)
  };
}

export function serializeAttachment(attachment: Attachment) {
  return {
    id: attachment.id,
    issueId: attachment.issueId,
    kind: attachment.kind,
    title: attachment.title,
    url: attachment.url ?? null,
    repoPath: attachment.repoPath ?? null,
    remote: attachment.remote ?? null,
    branchName: attachment.branchName ?? null,
    commitSha: attachment.commitSha ?? null,
    createdAt: toIso(attachment.createdAt)
  };
}

function serializeIssueReference(issue: IssueReference) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    teamId: issue.teamId,
    number: issue.number,
    title: issue.title
  };
}

export function serializeActivity(entry: Activity & { actor: Actor }) {
  return {
    id: entry.id,
    issueId: entry.issueId,
    actorId: entry.actorId,
    actor: serializeActor(entry.actor),
    action: entry.action,
    data: entry.data as Record<string, unknown>,
    createdAt: toIso(entry.createdAt)
  };
}

export function serializeActivityEvent(entry: ActivityFeedEvent) {
  return {
    cursor: entry.cursor,
    issueIdentifier: entry.issueIdentifier,
    ...serializeActivity(entry)
  };
}

export function serializeSavedView(view: SavedViewWithFilters) {
  return {
    id: view.id,
    name: view.name,
    filters: view.filters,
    description: view.description ?? null,
    createdAt: toIso(view.createdAt),
    updatedAt: toIso(view.updatedAt)
  };
}

export function serializeTemplate(template: TemplateWithLabels) {
  return {
    id: template.id,
    name: template.name,
    title: template.title ?? null,
    description: template.description ?? null,
    priority: template.priority ?? null,
    team: template.team ?? null,
    project: template.project ?? null,
    labels: template.labels,
    createdAt: toIso(template.createdAt),
    updatedAt: toIso(template.updatedAt)
  };
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: string | null): string | null {
  return value === null ? null : toIso(value);
}

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
