import { relations, sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  type AnySQLiteColumn
} from "drizzle-orm/sqlite-core";

export const workspace = sqliteTable("workspace", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique("teams_key_unique"),
  name: text("name").notNull(),
  issueCounter: integer("issue_counter").notNull().default(0),
  archivedAt: text("archived_at")
});

export const workflowStates = sqliteTable(
  "workflow_states",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["backlog", "unstarted", "started", "completed", "canceled"]
    }).notNull(),
    color: text("color").notNull(),
    position: real("position").notNull()
  },
  (table) => [unique("workflow_states_team_id_name_unique").on(table.teamId, table.name)]
);

export const actors = sqliteTable("actors", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["human", "agent"] }).notNull(),
  name: text("name").notNull(),
  handle: text("handle").notNull().unique("actors_handle_unique"),
  archivedAt: text("archived_at")
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", {
    enum: ["backlog", "planned", "started", "paused", "completed", "canceled"]
  }).notNull(),
  leadId: text("lead_id").references(() => actors.id),
  startDate: text("start_date"),
  targetDate: text("target_date"),
  archivedAt: text("archived_at")
});

export const milestones = sqliteTable("milestones", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  name: text("name").notNull(),
  targetDate: text("target_date"),
  position: real("position").notNull()
});

export const cycles = sqliteTable(
  "cycles",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    number: integer("number").notNull(),
    name: text("name"),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull()
  },
  (table) => [unique("cycles_team_id_number_unique").on(table.teamId, table.number)]
);

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull().unique("issues_identifier_unique"),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    stateId: text("state_id")
      .notNull()
      .references(() => workflowStates.id),
    priority: integer("priority").notNull().default(0),
    assigneeId: text("assignee_id").references(() => actors.id),
    creatorId: text("creator_id")
      .notNull()
      .references(() => actors.id),
    projectId: text("project_id").references(() => projects.id),
    cycleId: text("cycle_id").references(() => cycles.id),
    parentId: text("parent_id").references((): AnySQLiteColumn => issues.id),
    estimate: integer("estimate"),
    dueDate: text("due_date"),
    sortOrder: real("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    canceledAt: text("canceled_at"),
    archivedAt: text("archived_at")
  },
  (table) => [unique("issues_team_id_number_unique").on(table.teamId, table.number)]
);

export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    group: text("group"),
    groupKey: text("group_key")
      .notNull()
      .generatedAlwaysAs(sql`coalesce("group", '')`),
    archivedAt: text("archived_at")
  },
  (table) => [unique("labels_name_group_key_unique").on(table.name, table.groupKey)]
);

export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id)
  },
  (table) => [primaryKey({ columns: [table.issueId, table.labelId] })]
);

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  issueId: text("issue_id")
    .notNull()
    .references(() => issues.id),
  authorId: text("author_id")
    .notNull()
    .references(() => actors.id),
  body: text("body").notNull(),
  parentId: text("parent_id").references((): AnySQLiteColumn => comments.id),
  createdAt: text("created_at").notNull()
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  issueId: text("issue_id")
    .notNull()
    .references(() => issues.id),
  kind: text("kind", { enum: ["link", "branch", "pr", "commit"] }).notNull(),
  title: text("title").notNull(),
  url: text("url"),
  repoPath: text("repo_path"),
  remote: text("remote"),
  branchName: text("branch_name"),
  commitSha: text("commit_sha"),
  createdAt: text("created_at").notNull()
});

export const activity = sqliteTable("activity", {
  id: text("id").primaryKey(),
  issueId: text("issue_id")
    .notNull()
    .references(() => issues.id),
  actorId: text("actor_id")
    .notNull()
    .references(() => actors.id),
  action: text("action").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull()
});

export const workspaceRelations = relations(workspace, () => ({}));

export const configRelations = relations(config, () => ({}));

export const teamsRelations = relations(teams, ({ many }) => ({
  workflowStates: many(workflowStates),
  cycles: many(cycles),
  issues: many(issues)
}));

export const workflowStatesRelations = relations(workflowStates, ({ one, many }) => ({
  team: one(teams, {
    fields: [workflowStates.teamId],
    references: [teams.id]
  }),
  issues: many(issues)
}));

export const actorsRelations = relations(actors, ({ many }) => ({
  assignedIssues: many(issues, { relationName: "assignedIssues" }),
  createdIssues: many(issues, { relationName: "createdIssues" }),
  comments: many(comments),
  activity: many(activity)
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  lead: one(actors, {
    fields: [projects.leadId],
    references: [actors.id]
  }),
  milestones: many(milestones),
  issues: many(issues)
}));

export const milestonesRelations = relations(milestones, ({ one }) => ({
  project: one(projects, {
    fields: [milestones.projectId],
    references: [projects.id]
  })
}));

export const cyclesRelations = relations(cycles, ({ one, many }) => ({
  team: one(teams, {
    fields: [cycles.teamId],
    references: [teams.id]
  }),
  issues: many(issues)
}));

export const issuesRelations = relations(issues, ({ one, many }) => ({
  team: one(teams, {
    fields: [issues.teamId],
    references: [teams.id]
  }),
  state: one(workflowStates, {
    fields: [issues.stateId],
    references: [workflowStates.id]
  }),
  assignee: one(actors, {
    fields: [issues.assigneeId],
    references: [actors.id],
    relationName: "assignedIssues"
  }),
  creator: one(actors, {
    fields: [issues.creatorId],
    references: [actors.id],
    relationName: "createdIssues"
  }),
  project: one(projects, {
    fields: [issues.projectId],
    references: [projects.id]
  }),
  cycle: one(cycles, {
    fields: [issues.cycleId],
    references: [cycles.id]
  }),
  parent: one(issues, {
    fields: [issues.parentId],
    references: [issues.id],
    relationName: "subIssues"
  }),
  children: many(issues, { relationName: "subIssues" }),
  labels: many(issueLabels),
  comments: many(comments),
  attachments: many(attachments),
  activity: many(activity)
}));

export const labelsRelations = relations(labels, ({ many }) => ({
  issues: many(issueLabels)
}));

export const issueLabelsRelations = relations(issueLabels, ({ one }) => ({
  issue: one(issues, {
    fields: [issueLabels.issueId],
    references: [issues.id]
  }),
  label: one(labels, {
    fields: [issueLabels.labelId],
    references: [labels.id]
  })
}));

export const commentsRelations = relations(comments, ({ one, many }) => ({
  issue: one(issues, {
    fields: [comments.issueId],
    references: [issues.id]
  }),
  author: one(actors, {
    fields: [comments.authorId],
    references: [actors.id]
  }),
  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
    relationName: "commentThreads"
  }),
  replies: many(comments, { relationName: "commentThreads" })
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  issue: one(issues, {
    fields: [attachments.issueId],
    references: [issues.id]
  })
}));

export const activityRelations = relations(activity, ({ one }) => ({
  issue: one(issues, {
    fields: [activity.issueId],
    references: [issues.id]
  }),
  actor: one(actors, {
    fields: [activity.actorId],
    references: [actors.id]
  })
}));

export type Workspace = InferSelectModel<typeof workspace>;
export type NewWorkspace = InferInsertModel<typeof workspace>;
export type ConfigEntry = InferSelectModel<typeof config>;
export type NewConfigEntry = InferInsertModel<typeof config>;
export type Team = InferSelectModel<typeof teams>;
export type NewTeam = InferInsertModel<typeof teams>;
export type WorkflowState = InferSelectModel<typeof workflowStates>;
export type NewWorkflowState = InferInsertModel<typeof workflowStates>;
export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;
export type Milestone = InferSelectModel<typeof milestones>;
export type NewMilestone = InferInsertModel<typeof milestones>;
export type Cycle = InferSelectModel<typeof cycles>;
export type NewCycle = InferInsertModel<typeof cycles>;
export type Issue = InferSelectModel<typeof issues>;
export type NewIssue = InferInsertModel<typeof issues>;
export type Label = InferSelectModel<typeof labels>;
export type NewLabel = InferInsertModel<typeof labels>;
export type IssueLabel = InferSelectModel<typeof issueLabels>;
export type NewIssueLabel = InferInsertModel<typeof issueLabels>;
export type Comment = InferSelectModel<typeof comments>;
export type NewComment = InferInsertModel<typeof comments>;
export type Actor = InferSelectModel<typeof actors>;
export type NewActor = InferInsertModel<typeof actors>;
export type Attachment = InferSelectModel<typeof attachments>;
export type NewAttachment = InferInsertModel<typeof attachments>;
export type Activity = InferSelectModel<typeof activity>;
export type NewActivity = InferInsertModel<typeof activity>;
