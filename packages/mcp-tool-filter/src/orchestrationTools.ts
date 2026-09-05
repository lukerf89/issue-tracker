/**
 * Names of MCP tools that belong to the `pi` run-orchestration feature set
 * (autonomous-run lifecycle, orchestration profiles, repository registration,
 * engine catalog inspection, issue templates, and saved views). These are
 * irrelevant to a normal manual chat review session and are stripped from
 * `tools/list` responses by the filtering proxy in this package.
 *
 * This is a schema-advertisement filter ONLY: tool *calls* to any of these
 * names are still forwarded to the real server untouched (see proxy.ts).
 *
 * Source of truth: the registration call sites in `packages/mcp/src/tools/`.
 * Keep this list in sync with those modules — `test/orchestrationTools.test.ts`
 * fails (drift guard) if the real server's live tool list and this list
 * diverge (a tool renamed, removed, or a new orchestration tool added
 * without updating this file).
 */

// packages/mcp/src/tools/runs.ts
const RUN_TOOL_NAMES = [
  "preview_run",
  "start_run",
  "list_runs",
  "get_run",
  "list_run_events",
  "respond_to_run",
  "resolve_run_permission",
  "stop_run",
  "retry_run",
  "resume_run",
  "nudge_run",
  "list_run_artifacts",
  "archive_run",
  "publish_run",
  "cleanup_run",
  "get_run_metrics"
] as const;

// packages/mcp/src/tools/profiles.ts
const PROFILE_TOOL_NAMES = [
  "list_orchestration_profiles",
  "get_orchestration_profile",
  "add_orchestration_profile",
  "archive_orchestration_profile",
  "set_default_orchestration_profile"
] as const;

// packages/mcp/src/tools/repositories.ts
const REPOSITORY_TOOL_NAMES = [
  "list_repositories",
  "get_repository",
  "add_repository",
  "archive_repository",
  "associate_repository"
] as const;

// packages/mcp/src/tools/engines.ts
const ENGINE_TOOL_NAMES = ["list_engines", "get_engine", "validate_engines"] as const;

// packages/mcp/src/tools/templates.ts
const TEMPLATE_TOOL_NAMES = [
  "create_template",
  "list_templates",
  "delete_template",
  "create_issue_from_template"
] as const;

// packages/mcp/src/tools/savedViews.ts
const SAVED_VIEW_TOOL_NAMES = [
  "create_saved_view",
  "list_saved_views",
  "list_builtin_views",
  "delete_saved_view"
] as const;

export const ORCHESTRATION_TOOL_NAMES: readonly string[] = [
  ...RUN_TOOL_NAMES,
  ...PROFILE_TOOL_NAMES,
  ...REPOSITORY_TOOL_NAMES,
  ...ENGINE_TOOL_NAMES,
  ...TEMPLATE_TOOL_NAMES,
  ...SAVED_VIEW_TOOL_NAMES
];

export const ORCHESTRATION_TOOL_NAME_SET: ReadonlySet<string> = new Set(ORCHESTRATION_TOOL_NAMES);
