import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { asc, eq, sql } from "drizzle-orm";

import type { Clock } from "../clock.js";
import type { ServiceContext } from "../context.js";
import type { Db } from "../db/client.js";
import {
  activity,
  actors,
  attachments,
  comments,
  config,
  cycles,
  issueLabels,
  issues,
  labels,
  milestones,
  projects,
  savedViews,
  teams,
  templates,
  workflowStates,
  workspace,
  type Activity,
  type Attachment,
  type Comment,
  type ConfigEntry,
  type Issue,
  type IssueLabel,
  type Milestone,
  type SavedView,
  type Template,
  type Workspace
} from "../db/schema.js";
import {
  serializeActor,
  serializeCycle,
  serializeLabel,
  serializeProject,
  serializeSavedView,
  serializeTeam,
  serializeTemplate,
  serializeWorkflowState
} from "../serialize.js";
import { listIssueFiltersSchema } from "../schemas/issue.js";
import { templateLabelsSchema } from "../schemas/template.js";
import type { ListIssueFilters } from "./issue.js";

export interface ExportSnapshot {
  workspace: SerializedWorkspace | null;
  config: SerializedConfigEntry[];
  teams: ReturnType<typeof serializeTeam>[];
  workflowStates: ReturnType<typeof serializeWorkflowState>[];
  projects: ReturnType<typeof serializeProject>[];
  milestones: SerializedMilestone[];
  cycles: ReturnType<typeof serializeCycle>[];
  issues: SerializedIssue[];
  labels: ReturnType<typeof serializeLabel>[];
  issueLabels: SerializedIssueLabel[];
  comments: SerializedComment[];
  actors: ReturnType<typeof serializeActor>[];
  attachments: SerializedAttachment[];
  activity: SerializedActivity[];
  savedViews: ReturnType<typeof serializeSavedView>[];
  templates: ReturnType<typeof serializeTemplate>[];
}

export interface ResolveBackupPathInput {
  dbPath: string;
  output?: string;
  clock: Clock;
}

interface SerializedWorkspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface SerializedConfigEntry {
  key: string;
  value: string;
  updatedAt: string;
}

interface SerializedMilestone {
  id: string;
  projectId: string;
  name: string;
  targetDate: string | null;
  position: number;
}

interface SerializedIssue {
  id: string;
  identifier: string;
  teamId: string;
  number: number;
  title: string;
  description: string | null;
  stateId: string;
  priority: number;
  assigneeId: string | null;
  creatorId: string;
  projectId: string | null;
  cycleId: string | null;
  parentId: string | null;
  estimate: number | null;
  dueDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  archivedAt: string | null;
}

interface SerializedIssueLabel {
  issueId: string;
  labelId: string;
}

interface SerializedComment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  parentId: string | null;
  createdAt: string;
}

interface SerializedAttachment {
  id: string;
  issueId: string;
  kind: Attachment["kind"];
  title: string;
  url: string | null;
  repoPath: string | null;
  remote: string | null;
  branchName: string | null;
  commitSha: string | null;
  createdAt: string;
}

interface SerializedActivity {
  id: string;
  issueId: string;
  actorId: string;
  action: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export function exportSnapshot(context: ServiceContext): ExportSnapshot {
  const workspaceRow = context.db.query.workspace.findFirst({
    orderBy: [asc(workspace.id)]
  }).sync();

  return {
    workspace: workspaceRow ? serializeWorkspace(workspaceRow) : null,
    config: context.db.query.config.findMany({
      orderBy: [asc(config.key)]
    }).sync().map(serializeConfigEntry),
    teams: context.db.query.teams.findMany({
      orderBy: [asc(teams.key), asc(teams.id)]
    }).sync().map(serializeTeam),
    workflowStates: context.db.query.workflowStates.findMany({
      orderBy: [
        asc(workflowStates.teamId),
        asc(workflowStates.position),
        asc(workflowStates.name),
        asc(workflowStates.id)
      ]
    }).sync().map(serializeWorkflowState),
    projects: context.db.query.projects.findMany({
      orderBy: [asc(projects.name), asc(projects.id)]
    }).sync().map(serializeProject),
    milestones: context.db.query.milestones.findMany({
      orderBy: [asc(milestones.projectId), asc(milestones.position), asc(milestones.id)]
    }).sync().map(serializeMilestone),
    cycles: context.db.query.cycles.findMany({
      orderBy: [asc(cycles.teamId), asc(cycles.number), asc(cycles.id)]
    }).sync().map(serializeCycle),
    issues: context.db
      .select({ issue: issues })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .orderBy(asc(teams.key), asc(issues.number), asc(issues.id))
      .all()
      .map(({ issue }) => serializeIssueRow(issue)),
    labels: context.db.query.labels.findMany({
      orderBy: [asc(labels.groupKey), asc(labels.name), asc(labels.id)]
    }).sync().map(serializeLabel),
    issueLabels: context.db.query.issueLabels.findMany({
      orderBy: [asc(issueLabels.issueId), asc(issueLabels.labelId)]
    }).sync().map(serializeIssueLabel),
    comments: context.db.query.comments.findMany({
      orderBy: [asc(comments.issueId), asc(comments.createdAt), asc(comments.id)]
    }).sync().map(serializeCommentRow),
    actors: context.db.query.actors.findMany({
      orderBy: [asc(actors.handle), asc(actors.id)]
    }).sync().map(serializeActor),
    attachments: context.db.query.attachments.findMany({
      orderBy: [asc(attachments.issueId), asc(attachments.createdAt), asc(attachments.id)]
    }).sync().map(serializeAttachment),
    activity: context.db.query.activity.findMany({
      orderBy: [asc(activity.issueId), asc(activity.createdAt), sql`${activity}.rowid`]
    }).sync().map(serializeActivityRow),
    savedViews: context.db.query.savedViews.findMany({
      orderBy: [asc(savedViews.name), asc(savedViews.id)]
    }).sync().map((view) => serializeSavedView({
      ...view,
      filters: parseSavedViewFilters(view)
    })),
    templates: context.db.query.templates.findMany({
      orderBy: [asc(templates.name), asc(templates.id)]
    }).sync().map((template) => serializeTemplate({
      ...template,
      labels: parseTemplateLabels(template)
    }))
  };
}

export function resolveBackupPath(input: ResolveBackupPathInput): string {
  if (input.output) {
    return resolve(input.output);
  }

  return resolve(
    dirname(input.dbPath),
    `tracker-backup-${formatBackupTimestamp(input.clock.now())}.db`
  );
}

export function backupDatabase(db: Db, outputPath: string): string {
  const destination = resolve(outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  db.$client.prepare("VACUUM INTO ?").run(destination);
  return destination;
}

function serializeWorkspace(row: Workspace): SerializedWorkspace {
  return {
    id: row.id,
    name: row.name,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function serializeConfigEntry(row: ConfigEntry): SerializedConfigEntry {
  return {
    key: row.key,
    value: row.value,
    updatedAt: toIso(row.updatedAt)
  };
}

function serializeMilestone(row: Milestone): SerializedMilestone {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    targetDate: row.targetDate ?? null,
    position: row.position
  };
}

function serializeIssueRow(issue: Issue): SerializedIssue {
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

function serializeIssueLabel(row: IssueLabel): SerializedIssueLabel {
  return {
    issueId: row.issueId,
    labelId: row.labelId
  };
}

function serializeCommentRow(row: Comment): SerializedComment {
  return {
    id: row.id,
    issueId: row.issueId,
    authorId: row.authorId,
    body: row.body,
    parentId: row.parentId ?? null,
    createdAt: toIso(row.createdAt)
  };
}

function serializeAttachment(row: Attachment): SerializedAttachment {
  return {
    id: row.id,
    issueId: row.issueId,
    kind: row.kind,
    title: row.title,
    url: row.url ?? null,
    repoPath: row.repoPath ?? null,
    remote: row.remote ?? null,
    branchName: row.branchName ?? null,
    commitSha: row.commitSha ?? null,
    createdAt: toIso(row.createdAt)
  };
}

function serializeActivityRow(row: Activity): SerializedActivity {
  return {
    id: row.id,
    issueId: row.issueId,
    actorId: row.actorId,
    action: row.action,
    data: parseActivityData(row.data),
    createdAt: toIso(row.createdAt)
  };
}

function formatBackupTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join("");
}

function parseActivityData(data: unknown): Record<string, unknown> {
  const parsed = typeof data === "string" ? JSON.parse(data) as unknown : data;
  return isRecord(parsed) ? parsed : {};
}

function parseSavedViewFilters(view: SavedView): ListIssueFilters {
  const parsed = typeof view.filters === "string" ? JSON.parse(view.filters) as unknown : view.filters;
  return listIssueFiltersSchema.parse(parsed);
}

function parseTemplateLabels(template: Template): string[] {
  const parsed = typeof template.labels === "string" ? JSON.parse(template.labels) as unknown : template.labels;
  return templateLabelsSchema.parse(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function toIsoOrNull(value: string | null): string | null {
  return value === null ? null : toIso(value);
}
