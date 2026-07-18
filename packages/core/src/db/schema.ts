import { relations, sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
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

export const engineHealth = sqliteTable("engine_health", {
  engineName: text("engine_name").notNull(),
  fingerprint: text("fingerprint").notNull(),
  installed: integer("installed", { mode: "boolean" }).notNull(),
  authenticated: integer("authenticated", { mode: "boolean" }).notNull(),
  modelAccessible: integer("model_accessible", { mode: "boolean" }).notNull(),
  diagnosticCode: text("diagnostic_code"),
  remediation: text("remediation"),
  checkedAt: text("checked_at").notNull()
}, (table) => [primaryKey({ columns: [table.engineName, table.fingerprint] }), index("engine_health_checked_idx").on(table.checkedAt)]);

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
      enum: ["backlog", "unstarted", "started", "blocked", "completed", "canceled"]
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

export const issueDependencies = sqliteTable(
  "issue_dependencies",
  {
    blockingIssueId: text("blocking_issue_id")
      .notNull()
      .references(() => issues.id),
    blockedIssueId: text("blocked_issue_id")
      .notNull()
      .references(() => issues.id),
    createdAt: text("created_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.blockingIssueId, table.blockedIssueId] })]
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

export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique("saved_views_name_unique"),
  filters: text("filters", { mode: "json" }).notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const templates = sqliteTable("templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique("templates_name_unique"),
  title: text("title"),
  description: text("description"),
  priority: integer("priority"),
  team: text("team"),
  project: text("project"),
  labels: text("labels", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    canonicalPath: text("canonical_path").notNull(),
    commonDir: text("common_dir").notNull(),
    defaultBranch: text("default_branch").notNull(),
    remote: text("remote"),
    setupCommand: text("setup_command", { mode: "json" }),
    testCommand: text("test_command", { mode: "json" }).notNull(),
    verificationCommand: text("verification_command", { mode: "json" }).notNull(),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    unique("repositories_name_unique").on(table.name),
    unique("repositories_canonical_path_unique").on(table.canonicalPath),
    unique("repositories_common_dir_unique").on(table.commonDir)
  ]
);

export const projectRepositories = sqliteTable(
  "project_repositories",
  {
    projectId: text("project_id").notNull().references(() => projects.id),
    repositoryId: text("repository_id").notNull().references(() => repositories.id),
    position: integer("position").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false)
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.repositoryId] }),
    unique("project_repositories_position_unique").on(table.projectId, table.position),
    uniqueIndex("project_repositories_one_default")
      .on(table.projectId)
      .where(sql`${table.isDefault} = 1`)
  ]
);

export const issueRepositories = sqliteTable(
  "issue_repositories",
  {
    issueId: text("issue_id").notNull().references(() => issues.id),
    repositoryId: text("repository_id").notNull().references(() => repositories.id),
    position: integer("position").notNull(),
    overrideKind: text("override_kind", { enum: ["replace", "additional"] }).notNull().default("replace")
  },
  (table) => [
    primaryKey({ columns: [table.issueId, table.repositoryId] }),
    unique("issue_repositories_position_unique").on(table.issueId, table.position)
  ]
);

export const orchestrationProfiles = sqliteTable("orchestration_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique("orchestration_profiles_name_unique"),
  workflow: text("workflow").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  configuration: text("configuration", { mode: "json" }).notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("orchestration_profiles_one_default").on(table.isDefault).where(sql`${table.isDefault} = 1 AND ${table.archivedAt} IS NULL`)]);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull().references(() => issues.id),
    profileId: text("profile_id").references(() => orchestrationProfiles.id),
    workflow: text("workflow").notNull(),
    workflowVersion: integer("workflow_version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    resolvedConfiguration: text("resolved_configuration", { mode: "json" }).notNull(),
    phase: text("phase", { enum: ["preflight", "plan", "implement", "verify", "review", "finalize", "complete"] }).notNull(),
    state: text("state", { enum: ["queued", "provisioning", "running", "waiting_for_input", "blocked", "stalled", "succeeded", "partial", "failed", "canceled", "crashed"] }).notNull(),
    primaryRepositoryId: text("primary_repository_id").notNull().references(() => repositories.id),
    baseRef: text("base_ref").notNull(),
    baseCommit: text("base_commit").notNull(),
    branch: text("branch").notNull(),
    worktreePath: text("worktree_path").notNull(),
    parallelGroup: text("parallel_group"),
    eventCounter: integer("event_counter").notNull().default(0),
    attemptCounter: integer("attempt_counter").notNull().default(0),
    startedAt: text("started_at"),
    lastEventAt: text("last_event_at").notNull(),
    lastProgressAt: text("last_progress_at").notNull(),
    completedAt: text("completed_at"),
    outcome: text("outcome"),
    error: text("error", { mode: "json" }),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    unique("agent_runs_worktree_unique").on(table.worktreePath),
    uniqueIndex("agent_runs_one_active_per_issue").on(table.issueId).where(sql`${table.completedAt} IS NULL AND ${table.parallelGroup} IS NULL`),
    uniqueIndex("agent_runs_parallel_group_unique").on(table.issueId, table.parallelGroup).where(sql`${table.parallelGroup} IS NOT NULL`),
    index("agent_runs_state_created_idx").on(table.state, table.createdAt),
    check("agent_runs_terminal_timestamp", sql`(${table.state} IN ('succeeded','partial','failed','canceled','crashed') AND ${table.completedAt} IS NOT NULL) OR (${table.state} NOT IN ('succeeded','partial','failed','canceled','crashed') AND ${table.completedAt} IS NULL)`)
  ]
);

export const runRepositories = sqliteTable("run_repositories", {
  runId: text("run_id").notNull().references(() => agentRuns.id),
  repositoryId: text("repository_id").notNull().references(() => repositories.id),
  position: integer("position").notNull(),
  baseRef: text("base_ref").notNull(),
  baseCommit: text("base_commit").notNull(),
  worktreePath: text("worktree_path").notNull(),
  branch: text("branch").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull()
}, (table) => [primaryKey({ columns: [table.runId, table.repositoryId] }), unique("run_repositories_path_unique").on(table.worktreePath)]);

export const runAttempts = sqliteTable("run_attempts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  number: integer("number").notNull(),
  reason: text("reason").notNull(),
  requestedEngine: text("requested_engine", { mode: "json" }).notNull(),
  actualEngine: text("actual_engine", { mode: "json" }),
  state: text("state", { enum: ["queued", "running", "succeeded", "failed", "canceled", "crashed"] }).notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  result: text("result", { mode: "json" }),
  error: text("error", { mode: "json" }),
  createdAt: text("created_at").notNull()
}, (table) => [unique("run_attempts_number_unique").on(table.runId, table.number), uniqueIndex("run_attempts_one_active").on(table.runId).where(sql`${table.completedAt} IS NULL`)]);

export const runParticipants = sqliteTable("run_participants", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  attemptId: text("attempt_id").notNull().references(() => runAttempts.id),
  actor: text("actor").notNull(),
  role: text("role").notNull(),
  adapter: text("adapter").notNull(),
  requestedModel: text("requested_model").notNull(),
  actualModel: text("actual_model"),
  providerSessionId: text("provider_session_id"),
  capabilities: text("capabilities", { mode: "json" }).notNull(),
  processIdentity: text("process_identity", { mode: "json" }),
  state: text("state", { enum: ["queued", "running", "waiting", "succeeded", "failed", "stopped", "crashed"] }).notNull(),
  startedAt: text("started_at"),
  lastHeartbeatAt: text("last_heartbeat_at"),
  completedAt: text("completed_at")
});

export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  sequence: integer("sequence").notNull(),
  attemptId: text("attempt_id").references(() => runAttempts.id),
  participantId: text("participant_id").references(() => runParticipants.id),
  type: text("type").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  providerEventId: text("provider_event_id"),
  createdAt: text("created_at").notNull()
}, (table) => [unique("run_events_sequence_unique").on(table.runId, table.sequence), uniqueIndex("run_events_provider_unique").on(table.participantId, table.providerEventId).where(sql`${table.providerEventId} IS NOT NULL`)]);

export const runArtifacts = sqliteTable("run_artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  attemptId: text("attempt_id").references(() => runAttempts.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  localPath: text("local_path"),
  url: text("url"),
  sha256: text("sha256"),
  metadata: text("metadata", { mode: "json" }).notNull(),
  attachmentId: text("attachment_id").references(() => attachments.id),
  removedAt: text("removed_at"),
  createdAt: text("created_at").notNull()
});

export const runInputRequests = sqliteTable("run_input_requests", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  participantId: text("participant_id").notNull().references(() => runParticipants.id),
  kind: text("kind", { enum: ["input", "permission"] }).notNull(),
  prompt: text("prompt").notNull(),
  operation: text("operation", { mode: "json" }),
  blocking: integer("blocking", { mode: "boolean" }).notNull(),
  state: text("state", { enum: ["pending", "approved", "denied", "answered", "expired"] }).notNull(),
  response: text("response"),
  requestedBy: text("requested_by").notNull(),
  respondedBy: text("responded_by"),
  requestedAt: text("requested_at").notNull(),
  respondedAt: text("responded_at")
});

export const runVerifications = sqliteTable("run_verifications", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  attemptId: text("attempt_id").notNull().references(() => runAttempts.id),
  commitSha: text("commit_sha").notNull(),
  command: text("command", { mode: "json" }).notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at").notNull(),
  exitCode: integer("exit_code"),
  classification: text("classification", { enum: ["clean", "honest_partial", "fixable_partial", "audit_drift", "blocked", "engine_failure"] }).notNull(),
  logArtifactId: text("log_artifact_id").references(() => runArtifacts.id),
  summary: text("summary", { mode: "json" }).notNull()
});

export const runReviewFindings = sqliteTable("run_review_findings", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  participantId: text("participant_id").notNull().references(() => runParticipants.id),
  fingerprint: text("fingerprint").notNull(),
  severity: text("severity", { enum: ["info", "warning", "blocking"] }).notNull(),
  source: text("source", { enum: ["binding", "adversarial"] }).notNull(),
  file: text("file"),
  location: text("location"),
  summary: text("summary").notNull(),
  evidence: text("evidence").notNull(),
  resolution: text("resolution"),
  reconciliation: text("reconciliation", { enum: ["agreed", "binding_only", "adversary_only"] }),
  createdAt: text("created_at").notNull()
}, (table) => [unique("run_review_findings_fingerprint_unique").on(table.runId, table.participantId, table.fingerprint)]);

export const runActions = sqliteTable("run_actions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  attemptId: text("attempt_id").references(() => runAttempts.id),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique("run_actions_idempotency_unique"),
  payload: text("payload", { mode: "json" }).notNull(),
  state: text("state", { enum: ["queued", "claimed", "completed", "failed", "canceled"] }).notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  result: text("result", { mode: "json" }),
  error: text("error", { mode: "json" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at")
}, (table) => [index("run_actions_claim_idx").on(table.state, table.createdAt)]);

export const supervisorInstances = sqliteTable("supervisor_instances", {
  id: text("id").primaryKey(),
  processIdentity: text("process_identity", { mode: "json" }).notNull(),
  version: text("version").notNull(),
  capabilities: text("capabilities", { mode: "json" }).notNull(),
  startedAt: text("started_at").notNull(),
  lastHeartbeatAt: text("last_heartbeat_at").notNull()
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
  blocks: many(issueDependencies, { relationName: "issueBlocks" }),
  blockedBy: many(issueDependencies, { relationName: "issueBlockedBy" }),
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

export const issueDependenciesRelations = relations(issueDependencies, ({ one }) => ({
  blockingIssue: one(issues, {
    fields: [issueDependencies.blockingIssueId],
    references: [issues.id],
    relationName: "issueBlocks"
  }),
  blockedIssue: one(issues, {
    fields: [issueDependencies.blockedIssueId],
    references: [issues.id],
    relationName: "issueBlockedBy"
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

export const savedViewsRelations = relations(savedViews, () => ({}));

export const templatesRelations = relations(templates, () => ({}));

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
export type IssueDependency = InferSelectModel<typeof issueDependencies>;
export type NewIssueDependency = InferInsertModel<typeof issueDependencies>;
export type Comment = InferSelectModel<typeof comments>;
export type NewComment = InferInsertModel<typeof comments>;
export type Actor = InferSelectModel<typeof actors>;
export type NewActor = InferInsertModel<typeof actors>;
export type Attachment = InferSelectModel<typeof attachments>;
export type NewAttachment = InferInsertModel<typeof attachments>;
export type Activity = InferSelectModel<typeof activity>;
export type NewActivity = InferInsertModel<typeof activity>;
export type SavedView = InferSelectModel<typeof savedViews>;
export type NewSavedView = InferInsertModel<typeof savedViews>;
export type Template = InferSelectModel<typeof templates>;
export type NewTemplate = InferInsertModel<typeof templates>;
export type Repository = InferSelectModel<typeof repositories>;
export type NewRepository = InferInsertModel<typeof repositories>;
export type OrchestrationProfile = InferSelectModel<typeof orchestrationProfiles>;
export type AgentRun = InferSelectModel<typeof agentRuns>;
export type RunAttempt = InferSelectModel<typeof runAttempts>;
export type RunParticipant = InferSelectModel<typeof runParticipants>;
export type RunEvent = InferSelectModel<typeof runEvents>;
export type RunArtifact = InferSelectModel<typeof runArtifacts>;
export type RunInputRequest = InferSelectModel<typeof runInputRequests>;
export type RunVerification = InferSelectModel<typeof runVerifications>;
export type RunReviewFinding = InferSelectModel<typeof runReviewFindings>;
export type RunAction = InferSelectModel<typeof runActions>;
export type SupervisorInstance = InferSelectModel<typeof supervisorInstances>;
