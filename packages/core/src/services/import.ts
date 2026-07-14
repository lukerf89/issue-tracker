import { z } from "zod";

import { inTransaction, type ServiceContext, type ServiceTransaction } from "../context.js";
import {
  activity,
  actors,
  attachments,
  comments,
  config,
  cycles,
  issueDependencies,
  issueLabels,
  issues,
  labels,
  milestones,
  projects,
  savedViews,
  teams,
  templates,
  workflowStates,
  workspace
} from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { attachmentKindSchema } from "../schemas/attachment.js";
import { actorTypeSchema } from "../schemas/actor.js";
import { dateOnlyStringSchema } from "../schemas/common.js";
import { listIssueFiltersSchema, prioritySchema } from "../schemas/issue.js";
import { projectStatusSchema } from "../schemas/project.js";
import { templateLabelsSchema } from "../schemas/template.js";

export interface ImportSnapshotOptions {
  force?: boolean;
}

export interface ImportSnapshotSummary {
  workspace: number;
  config: number;
  teams: number;
  workflowStates: number;
  projects: number;
  milestones: number;
  cycles: number;
  issues: number;
  labels: number;
  issueLabels: number;
  issueDependencies: number;
  comments: number;
  actors: number;
  attachments: number;
  activity: number;
  savedViews: number;
  templates: number;
}

const workflowStateTypeSchema = z.enum([
  "backlog",
  "unstarted",
  "started",
  "blocked",
  "completed",
  "canceled"
]);
const isoTimestampSchema = z.string().datetime({ offset: true });
const nullableIsoTimestampSchema = isoTimestampSchema.nullable();
const nullableStringSchema = z.string().nullable();
const nullableDateOnlyStringSchema = dateOnlyStringSchema.nullable();
const jsonRecordSchema = z.record(z.string(), z.unknown());

const workspaceSnapshotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

const configEntrySnapshotSchema = z.strictObject({
  key: z.string(),
  value: z.string(),
  updatedAt: isoTimestampSchema
});

const teamSnapshotSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  issueCounter: z.number().int().min(0),
  archivedAt: nullableIsoTimestampSchema
});

const workflowStateSnapshotSchema = z.strictObject({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  type: workflowStateTypeSchema,
  color: z.string(),
  position: z.number()
});

const projectSnapshotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: nullableStringSchema,
  status: projectStatusSchema,
  leadId: nullableStringSchema,
  startDate: nullableDateOnlyStringSchema,
  targetDate: nullableDateOnlyStringSchema,
  archivedAt: nullableIsoTimestampSchema
});

const milestoneSnapshotSchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  targetDate: nullableStringSchema,
  position: z.number()
});

const cycleSnapshotSchema = z.strictObject({
  id: z.string(),
  teamId: z.string(),
  number: z.number().int().min(1),
  name: nullableStringSchema,
  startsAt: isoTimestampSchema,
  endsAt: isoTimestampSchema
});

const issueSnapshotSchema = z.strictObject({
  id: z.string(),
  identifier: z.string(),
  teamId: z.string(),
  number: z.number().int().min(1),
  title: z.string(),
  description: nullableStringSchema,
  stateId: z.string(),
  priority: prioritySchema,
  assigneeId: nullableStringSchema,
  creatorId: z.string(),
  projectId: nullableStringSchema,
  cycleId: nullableStringSchema,
  parentId: nullableStringSchema,
  estimate: z.number().int().nullable(),
  dueDate: nullableDateOnlyStringSchema,
  sortOrder: z.number(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  startedAt: nullableIsoTimestampSchema,
  completedAt: nullableIsoTimestampSchema,
  canceledAt: nullableIsoTimestampSchema,
  archivedAt: nullableIsoTimestampSchema
});

const labelSnapshotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  group: nullableStringSchema,
  archivedAt: nullableIsoTimestampSchema
});

const issueLabelSnapshotSchema = z.strictObject({
  issueId: z.string(),
  labelId: z.string()
});

const issueDependencySnapshotSchema = z.strictObject({
  blockingIssueId: z.string(),
  blockedIssueId: z.string(),
  createdAt: isoTimestampSchema
});

const commentSnapshotSchema = z.strictObject({
  id: z.string(),
  issueId: z.string(),
  authorId: z.string(),
  body: z.string(),
  parentId: nullableStringSchema,
  createdAt: isoTimestampSchema
});

const actorSnapshotSchema = z.strictObject({
  id: z.string(),
  type: actorTypeSchema,
  name: z.string(),
  handle: z.string(),
  archivedAt: nullableIsoTimestampSchema
});

const attachmentSnapshotSchema = z.strictObject({
  id: z.string(),
  issueId: z.string(),
  kind: attachmentKindSchema,
  title: z.string(),
  url: nullableStringSchema,
  repoPath: nullableStringSchema,
  remote: nullableStringSchema,
  branchName: nullableStringSchema,
  commitSha: nullableStringSchema,
  createdAt: isoTimestampSchema
});

const activitySnapshotSchema = z.strictObject({
  id: z.string(),
  issueId: z.string(),
  actorId: z.string(),
  action: z.string(),
  data: jsonRecordSchema,
  createdAt: isoTimestampSchema
});

const savedViewSnapshotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  filters: listIssueFiltersSchema,
  description: nullableStringSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

const templateSnapshotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  title: nullableStringSchema,
  description: nullableStringSchema,
  priority: prioritySchema.nullable(),
  team: nullableStringSchema,
  project: nullableStringSchema,
  labels: templateLabelsSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const importSnapshotSchema = z.strictObject({
  workspace: workspaceSnapshotSchema.nullable(),
  config: z.array(configEntrySnapshotSchema),
  teams: z.array(teamSnapshotSchema),
  workflowStates: z.array(workflowStateSnapshotSchema),
  projects: z.array(projectSnapshotSchema),
  milestones: z.array(milestoneSnapshotSchema),
  cycles: z.array(cycleSnapshotSchema),
  issues: z.array(issueSnapshotSchema),
  labels: z.array(labelSnapshotSchema),
  issueLabels: z.array(issueLabelSnapshotSchema),
  issueDependencies: z.array(issueDependencySnapshotSchema).default([]),
  comments: z.array(commentSnapshotSchema),
  actors: z.array(actorSnapshotSchema),
  attachments: z.array(attachmentSnapshotSchema),
  activity: z.array(activitySnapshotSchema),
  savedViews: z.array(savedViewSnapshotSchema),
  templates: z.array(templateSnapshotSchema)
});

export type ImportSnapshot = z.infer<typeof importSnapshotSchema>;

export function importSnapshot(
  context: ServiceContext,
  snapshot: unknown,
  options: ImportSnapshotOptions = {}
): ImportSnapshotSummary {
  const parsed = importSnapshotSchema.parse(snapshot);

  return inTransaction(context, (txContext) => {
    if (options.force) {
      clearWorkspace(txContext);
    } else {
      assertWorkspaceEmpty(txContext);
    }

    if (parsed.workspace) {
      txContext.db.insert(workspace).values(parsed.workspace).run();
    }
    if (parsed.teams.length > 0) txContext.db.insert(teams).values(parsed.teams).run();
    if (parsed.actors.length > 0) txContext.db.insert(actors).values(parsed.actors).run();
    if (parsed.config.length > 0) txContext.db.insert(config).values(parsed.config).run();
    if (parsed.workflowStates.length > 0) {
      txContext.db.insert(workflowStates).values(parsed.workflowStates).run();
    }
    if (parsed.projects.length > 0) txContext.db.insert(projects).values(parsed.projects).run();
    if (parsed.milestones.length > 0) {
      txContext.db.insert(milestones).values(parsed.milestones).run();
    }
    if (parsed.cycles.length > 0) txContext.db.insert(cycles).values(parsed.cycles).run();
    if (parsed.labels.length > 0) txContext.db.insert(labels).values(parsed.labels).run();
    if (parsed.savedViews.length > 0) {
      txContext.db.insert(savedViews).values(parsed.savedViews).run();
    }
    if (parsed.templates.length > 0) {
      txContext.db.insert(templates).values(parsed.templates).run();
    }

    const orderedIssues = orderByParent(parsed.issues, "issue");
    if (orderedIssues.length > 0) txContext.db.insert(issues).values(orderedIssues).run();
    if (parsed.issueLabels.length > 0) {
      txContext.db.insert(issueLabels).values(parsed.issueLabels).run();
    }
    if (parsed.issueDependencies.length > 0) {
      txContext.db.insert(issueDependencies).values(parsed.issueDependencies).run();
    }

    const orderedComments = orderByParent(parsed.comments, "comment");
    if (orderedComments.length > 0) txContext.db.insert(comments).values(orderedComments).run();
    if (parsed.attachments.length > 0) {
      txContext.db.insert(attachments).values(parsed.attachments).run();
    }
    if (parsed.activity.length > 0) txContext.db.insert(activity).values(parsed.activity).run();

    return summarizeSnapshot(parsed);
  });
}

function assertWorkspaceEmpty(context: ServiceContext & { db: ServiceTransaction }): void {
  const occupiedTables = existingWorkspaceTables(context);

  if (occupiedTables.length === 0) {
    return;
  }

  throw new AppError(
    AppErrorCode.CONSTRAINT_VIOLATION,
    "Import requires an empty database. Re-run with force to replace existing data.",
    { tables: occupiedTables, force: true }
  );
}

function existingWorkspaceTables(context: ServiceContext & { db: ServiceTransaction }): string[] {
  const checks: Array<[string, unknown]> = [
    ["workspace", context.db.query.workspace.findFirst().sync()],
    ["config", context.db.query.config.findFirst().sync()],
    ["teams", context.db.query.teams.findFirst().sync()],
    ["workflow_states", context.db.query.workflowStates.findFirst().sync()],
    ["projects", context.db.query.projects.findFirst().sync()],
    ["milestones", context.db.query.milestones.findFirst().sync()],
    ["cycles", context.db.query.cycles.findFirst().sync()],
    ["issues", context.db.query.issues.findFirst().sync()],
    ["labels", context.db.query.labels.findFirst().sync()],
    ["issue_labels", context.db.query.issueLabels.findFirst().sync()],
    ["issue_dependencies", context.db.query.issueDependencies.findFirst().sync()],
    ["comments", context.db.query.comments.findFirst().sync()],
    ["actors", context.db.query.actors.findFirst().sync()],
    ["attachments", context.db.query.attachments.findFirst().sync()],
    ["activity", context.db.query.activity.findFirst().sync()],
    ["saved_views", context.db.query.savedViews.findFirst().sync()],
    ["templates", context.db.query.templates.findFirst().sync()]
  ];

  return checks.filter(([, row]) => row !== undefined).map(([name]) => name);
}

function clearWorkspace(context: ServiceContext & { db: ServiceTransaction }): void {
  context.db.delete(activity).run();
  context.db.delete(attachments).run();
  context.db.delete(comments).run();
  context.db.delete(issueLabels).run();
  context.db.delete(issueDependencies).run();
  context.db.delete(issues).run();
  context.db.delete(templates).run();
  context.db.delete(savedViews).run();
  context.db.delete(milestones).run();
  context.db.delete(projects).run();
  context.db.delete(cycles).run();
  context.db.delete(workflowStates).run();
  context.db.delete(labels).run();
  context.db.delete(config).run();
  context.db.delete(actors).run();
  context.db.delete(teams).run();
  context.db.delete(workspace).run();
}

function orderByParent<T extends { id: string; parentId: string | null }>(
  rows: T[],
  entityName: string
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const row of rows) {
    visitParentFirst(row, byId, ordered, visiting, visited, entityName);
  }

  return ordered;
}

function visitParentFirst<T extends { id: string; parentId: string | null }>(
  row: T,
  byId: Map<string, T>,
  ordered: T[],
  visiting: Set<string>,
  visited: Set<string>,
  entityName: string
): void {
  if (visited.has(row.id)) return;

  if (visiting.has(row.id)) {
    throw new AppError(
      AppErrorCode.CONSTRAINT_VIOLATION,
      `Import snapshot contains a ${entityName} parent cycle.`,
      { id: row.id, parentId: row.parentId }
    );
  }

  visiting.add(row.id);

  if (row.parentId) {
    const parent = byId.get(row.parentId);
    if (parent) {
      visitParentFirst(parent, byId, ordered, visiting, visited, entityName);
    }
  }

  visiting.delete(row.id);
  visited.add(row.id);
  ordered.push(row);
}

function summarizeSnapshot(snapshot: ImportSnapshot): ImportSnapshotSummary {
  return {
    workspace: snapshot.workspace ? 1 : 0,
    config: snapshot.config.length,
    teams: snapshot.teams.length,
    workflowStates: snapshot.workflowStates.length,
    projects: snapshot.projects.length,
    milestones: snapshot.milestones.length,
    cycles: snapshot.cycles.length,
    issues: snapshot.issues.length,
    labels: snapshot.labels.length,
    issueLabels: snapshot.issueLabels.length,
    issueDependencies: snapshot.issueDependencies.length,
    comments: snapshot.comments.length,
    actors: snapshot.actors.length,
    attachments: snapshot.attachments.length,
    activity: snapshot.activity.length,
    savedViews: snapshot.savedViews.length,
    templates: snapshot.templates.length
  };
}
