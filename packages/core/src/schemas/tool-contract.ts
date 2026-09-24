import { z } from "zod";

import { AppError, AppErrorCode } from "../errors.js";

import { workContextResponseSchema } from "./work-context.js";
import { activityArraySchema, advertisedOutputSchemas as advertised, exactOutputSchemas as exact } from "./tool-output.js";

/**
 * MCP behavior hints (https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
 * Read-only tools set only readOnlyHint and openWorldHint; the other hints are meaningless for them.
 */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface ToolContract {
  annotations: ToolAnnotations;
  /**
   * True when the tool returns structuredContent next to its text block and advertises
   * `outputSchema`. Only single-shape object outputs whose size the caller controls are structured;
   * budgeted or unbounded reads (arbitrary run payloads, full issue detail) and bare-array lists
   * stay text-only so large payloads are not duplicated.
   */
  structured: boolean;
  /** The advertised (loose, object-root) schema. Present exactly when `structured` is true. */
  outputSchema?: z.ZodType<Record<string, unknown>>;
  /**
   * The exact success-response contract (strict where the shape is fixed; a union where the tool
   * has several response modes). Absent only for the engine tools, whose output mirrors the
   * operator's local engine catalog.
   */
  responseSchema?: z.ZodType;
}

/**
 * Hints are derived from each tool's transaction-level effects, audited per concrete service:
 *
 * - readOnlyHint: the call writes no row and provisions no actor (MCP reads resolve the caller
 *   without creating it). Per-call migrations and data-directory creation are idempotent bootstrap.
 * - destructiveHint=false: purely additive. No DELETE and no UPDATE of a pre-existing column,
 *   except bookkeeping: issues.revision/updated_at (the 0011 revision triggers), the team issue
 *   counter and FTS shadow tables. Activity appends are inserts.
 * - idempotentHint=true: a repeat call with the same arguments has no further observable effect
 *   (an early return, a conflict error that writes nothing, or a rewrite that leaves identical rows). Services that re-stamp timestamps or
 *   append rows on a repeat are false, as is every create (keyed or not). Hints default to false
 *   unless a repeat-call test under an advancing clock proves no second write. Field updates
 *   (update/move/assign/claim) are proven: every field has set semantics (label and dependency
 *   edits add or remove set members) and an unchanged mutation writes nothing, not even updatedAt.
 * - structured: list_issues and search stay structured. Their default rows are fixed summary keys;
 *   `fields` can opt into description, so the caller controls that size (get_issue and
 *   read_issue_section are the budgeted paths for long text). Run records, events and artifacts
 *   carry arbitrary engine payloads with no byte budget, so they stay text-only.
 * - openWorldHint: only the run tools whose effects reach an external agent process, provider
 *   session or remote (start/retry/resume/nudge/publish).
 */
const read = (title: string, responseSchema?: z.ZodType): ToolContract => ({
  annotations: { title, readOnlyHint: true, openWorldHint: false },
  structured: false,
  ...(responseSchema ? { responseSchema } : {})
});

const write = (
  title: string,
  hints: { destructive: boolean; idempotent: boolean; openWorld?: boolean },
  responseSchema: z.ZodType
): ToolContract => ({
  annotations: {
    title,
    readOnlyHint: false,
    destructiveHint: hints.destructive,
    idempotentHint: hints.idempotent,
    openWorldHint: hints.openWorld ?? false
  },
  structured: false,
  responseSchema
});

/** Marks a contract structured: advertises `outputSchema` and returns structuredContent. */
const structured = (contract: ToolContract, outputSchema: z.ZodType<Record<string, unknown>>): ToolContract => ({
  ...contract,
  structured: true,
  outputSchema
});

const additive = { destructive: false, idempotent: false } as const;
const overwrite = { destructive: true, idempotent: false } as const;
const overwriteOnce = { destructive: true, idempotent: true } as const;
const provisionOnce = { destructive: false, idempotent: true } as const;
const external = { destructive: true, idempotent: false, openWorld: true } as const;

const issueMutation = z.union([exact.issueMutationFull, exact.issueMutationReceipt]);
const runMutation = z.union([exact.runFull, exact.runSummary]);
const record = z.record(z.string(), z.unknown());

const contracts = {
  // Actors
  whoami: structured(write("Get current actor", provisionOnce, exact.actor), advertised.actor),
  get_current_actor: structured(write("Get current actor", provisionOnce, exact.actor), advertised.actor),
  create_actor: structured(write("Create actor", additive, exact.actor), advertised.actor),
  list_actors: read("List actors", z.array(exact.actor)),

  // Engines (local configuration files only; no database access)
  list_engines: read("List engines"),
  get_engine: read("Get engine"),
  validate_engines: read("Validate engines"),

  // Issues
  get_issues: read("Read selected issues", exact.issuesRead),
  read_issue_section: read("Read issue section", exact.issueSection),
  get_work_context: read("Read work context", workContextResponseSchema),
  get_issue: read("Get issue", exact.issueDetail),
  list_issues: structured(read("List issues", exact.issueSummaryPage), advertised.issueSummaryPage),
  search: structured(read("Search issues", exact.issueSummaryPage), advertised.issueSummaryPage),
  list_activity: read("List issue activity", z.union([exact.activityPage, activityArraySchema])),
  list_activity_feed: read("List activity feed", exact.activityFeed),
  claim_issue: structured(write("Claim issue", overwriteOnce, exact.issue), advertised.issueMutation),
  create_issue: structured(write("Create issue", additive, issueMutation), advertised.issueMutation),
  update_issue: structured(write("Update issue", overwriteOnce, issueMutation), advertised.issueMutation),
  move_issue: structured(write("Move issue", overwriteOnce, issueMutation), advertised.issueMutation),
  assign_issue: structured(write("Assign issue", overwriteOnce, issueMutation), advertised.issueMutation),
  archive_issue: structured(write("Archive issue", overwriteOnce, issueMutation), advertised.issueMutation),
  unarchive_issue: structured(write("Unarchive issue", overwriteOnce, issueMutation), advertised.issueMutation),
  comment_on_issue: structured(write("Comment on issue", additive, exact.commentMutation), advertised.commentMutation),
  link_issue: structured(write("Link issue", additive, exact.attachmentMutation), advertised.attachmentMutation),

  // Cycles
  create_cycle: structured(write("Create cycle", additive, exact.cycle), advertised.cycle),
  list_cycles: read("List cycles", z.array(exact.cycle)),

  // Labels
  create_label: structured(write("Create label", additive, exact.label), advertised.label),
  list_labels: read("List labels", z.array(exact.label)),
  archive_label: structured(write("Archive label", overwriteOnce, exact.label), advertised.label),
  unarchive_label: structured(write("Unarchive label", overwriteOnce, exact.label), advertised.label),

  // Metadata
  describe: write("Describe tracker metadata", provisionOnce, exact.describe),
  list_states: read("List workflow states", z.array(exact.workflowState)),

  // Projects
  list_projects: read("List projects", z.array(exact.project)),
  get_project: structured(read("Get project", exact.project), advertised.project),
  create_project: structured(write("Create project", additive, exact.project), advertised.project),
  update_project: structured(write("Update project", overwriteOnce, exact.project), advertised.project),
  archive_project: structured(write("Archive project", overwriteOnce, exact.project), advertised.project),
  unarchive_project: structured(write("Unarchive project", overwriteOnce, exact.project), advertised.project),

  // Orchestration profiles (adding a default profile clears isDefault on the others)
  list_orchestration_profiles: read("List profiles", z.array(exact.profile)),
  get_orchestration_profile: structured(read("Get profile", exact.profile), advertised.profile),
  add_orchestration_profile: structured(write("Add profile", overwrite, exact.profile), advertised.profile),
  archive_orchestration_profile: structured(write("Archive profile", overwrite, exact.profile), advertised.profile),
  set_default_orchestration_profile: structured(write("Set default profile", overwrite, exact.profile), advertised.profile),

  // Repositories (association replaces the existing link row: delete + insert)
  list_repositories: read("List repositories", z.array(exact.repository)),
  get_repository: structured(read("Get repository", exact.repository), advertised.repository),
  add_repository: structured(write("Add repository", additive, exact.repository), advertised.repository),
  archive_repository: structured(write("Archive repository", overwriteOnce, exact.repository), advertised.repository),
  associate_repository: structured(write("Associate repository", overwriteOnce, exact.repository), advertised.repository),

  // Runs
  preview_run: read("Preview run", z.looseObject({ previewFingerprint: z.string(), warnings: z.array(z.string()), errors: z.array(z.string()) })),
  start_run: write("Start run", external, exact.runFull),
  list_runs: structured(read("List runs", exact.runSummaryPage), advertised.runSummaryPage),
  get_run: read("Get run", runMutation),
  list_run_records: read("List run records", exact.runRecordsPage),
  list_run_events: read("List run events", exact.runEventsPage),
  respond_to_run: write("Respond to run", overwrite, record),
  resolve_run_permission: write("Resolve permission", overwrite, record),
  stop_run: write("Stop run", overwrite, runMutation),
  retry_run: write("Retry run", external, runMutation),
  resume_run: write("Resume run", external, runMutation),
  nudge_run: write("Nudge run", external, runMutation),
  list_run_artifacts: read("List run artifacts", exact.runRecordsPage),
  archive_run: write("Archive run", overwrite, runMutation),
  publish_run: write("Publish run", external, record),
  cleanup_run: write("Clean up run", overwrite, record),
  get_run_metrics: structured(read("Get run metrics", exact.runMetrics), advertised.runMetrics),

  // Saved views
  list_builtin_views: read("List built-in views", z.array(exact.builtinView)),
  create_saved_view: structured(write("Create saved view", additive, exact.savedView), advertised.savedView),
  list_saved_views: read("List saved views", z.array(exact.savedView)),
  delete_saved_view: structured(write("Delete saved view", overwriteOnce, exact.savedView), advertised.savedView),

  // Teams
  create_team: structured(write("Create team", additive, exact.team), advertised.team),
  list_teams: read("List teams", z.array(exact.team)),
  archive_team: structured(write("Archive team", overwriteOnce, exact.team), advertised.team),
  unarchive_team: structured(write("Unarchive team", overwriteOnce, exact.team), advertised.team),

  // Templates
  create_template: structured(write("Create template", additive, exact.template), advertised.template),
  list_templates: read("List templates", z.array(exact.template)),
  delete_template: structured(write("Delete template", overwriteOnce, exact.template), advertised.template),
  create_issue_from_template: structured(write("Create issue from template", additive, exact.issueFromTemplate), advertised.issueMutation)
} satisfies Record<string, ToolContract>;

export type ToolName = keyof typeof contracts;

/** The contract for a registered MCP tool. Throws on an unknown name so a new tool cannot ship without one. */
export function toolContract(name: string): ToolContract {
  if (!Object.prototype.hasOwnProperty.call(contracts, name)) {
    throw new AppError(AppErrorCode.TOOL_CONTRACT_VIOLATION, `No tool contract is defined for ${name}.`, { tool: name });
  }
  return contracts[name as ToolName];
}

export function toolContractNames(): ToolName[] {
  return (Object.keys(contracts) as ToolName[]).sort();
}
