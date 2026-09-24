import { builtinProfileInput } from "@issue-tracker/core";

import type { ContractFixture } from "./contract-fixture.js";

type Seed = ContractFixture["seed"];

export interface Scenario {
  tool: string;
  args: (seed: Seed, fixture: ContractFixture) => Record<string, unknown>;
  /** A short label when one tool has several scenarios (response modes, projections). */
  label?: string;
}

const s = (tool: string, args: Scenario["args"] | Record<string, unknown> = {}, label?: string): Scenario => ({
  tool,
  args: typeof args === "function" ? args : () => args,
  ...(label ? { label } : {})
});

/**
 * Successful calls for every read-only tool, in order. The reader client runs these with an agent
 * handle that does not exist in the database.
 */
export const readScenarios: Scenario[] = [
  s("list_actors"),
  s("list_engines", (_, f) => ({ config: f.engineConfig })),
  s("get_engine", (_, f) => ({ config: f.engineConfig, engine: "claude-default" })),
  s("validate_engines", (_, f) => ({ config: f.engineConfig })),
  s("get_issues", { identifiers: ["ENG-1", "ENG-2"] }),
  s("read_issue_section", { identifier: "ENG-1", path: ["description"] }),
  s("get_work_context", { identifier: "ENG-1" }),
  s("get_issue", { identifier: "ENG-1" }),
  s("list_issues", {}),
  s("list_issues", { view: "builtin:my-open" }, "caller-sensitive view"),
  s("list_issues", { fields: ["description", "labels", "stateName", "assigneeHandle"], limit: 2 }, "projected page"),
  s("search", { query: "fictional" }),
  s("list_activity", { issue: "ENG-1" }, "paged"),
  s("list_activity", { issue: "ENG-1", full: true }, "full"),
  s("list_activity_feed"),
  s("list_cycles"),
  s("list_labels"),
  s("list_states", { team: "ENG" }),
  s("list_projects"),
  s("get_project", { project: "Fictional Delivery" }),
  s("list_orchestration_profiles"),
  s("get_orchestration_profile", { profile: "Fictional Review" }),
  s("list_repositories"),
  s("get_repository", { repository: "Primary" }),
  s("preview_run", { issue: "ENG-1" }),
  s("list_runs"),
  s("get_run", (seed) => ({ run: seed.run }), "full"),
  s("get_run", (seed) => ({ run: seed.run, view: "summary" }), "summary"),
  s("list_run_records", (seed) => ({ run: seed.run, collection: "participants" })),
  s("list_run_events", (seed) => ({ run: seed.run })),
  s("list_run_artifacts", (seed) => ({ run: seed.run })),
  s("get_run_metrics"),
  s("list_builtin_views"),
  s("list_saved_views"),
  s("list_teams"),
  s("list_templates")
];

/**
 * Successful calls for every write tool the harness can drive, in dependency order (the writer
 * client). Pairs such as archive/unarchive run back to back.
 */
export const writeScenarios: Scenario[] = [
  s("whoami"),
  s("get_current_actor"),
  s("describe"),
  s("create_actor", { type: "agent", name: "Fictional Bot", handle: "fictional-bot" }),
  s("create_issue", { title: "Fictional release notes" }, "full"),
  s("create_issue", { title: "Fictional changelog", idempotencyKey: "fictional-changelog", response: "compact" }, "compact"),
  s("comment_on_issue", { issue: "ENG-1", body: "Fictional progress note" }),
  s("link_issue", { issue: "ENG-1", kind: "link", title: "Fictional doc", url: "https://example.test/doc" }),
  s("create_cycle", { team: "ENG", startsAt: "2026-03-01T00:00:00.000Z", endsAt: "2026-03-15T00:00:00.000Z" }),
  s("create_label", { name: "Chore" }),
  s("create_project", { name: "Fictional Roadmap" }),
  s("add_repository", (seed) => ({ name: "Tertiary", path: seed.tertiaryPath, ...seed.commands })),
  s("create_saved_view", { name: "Urgent", filters: { priority: 1 } }),
  s("create_team", { key: "QA", name: "Fictional QA" }),
  s("create_template", { name: "Chore", title: "Fictional chore" }),
  s("create_issue_from_template", { name: "Bugfix" }),
  s("archive_label", { label: "Bug" }),
  s("unarchive_label", { label: "Bug" }),
  s("archive_project", { project: "Fictional Archive" }),
  s("unarchive_project", { project: "Fictional Archive" }),
  s("archive_issue", { identifier: "ENG-3" }, "full"),
  s("unarchive_issue", { identifier: "ENG-3", response: "compact" }, "compact"),
  s("archive_team", { team: "OPS" }),
  s("unarchive_team", { team: "OPS" }),
  s("archive_repository", { repository: "Secondary" }),
  s("associate_repository", { repository: "Primary", project: "Fictional Delivery", isDefault: true }),
  s("delete_saved_view", { idOrName: "Mine" }),
  s("delete_template", { name: "Bugfix" }),
  s("update_issue", { identifier: "ENG-2", priority: 2 }, "full"),
  s("update_issue", { identifier: "ENG-2", priority: 3, response: "compact" }, "compact"),
  s("update_issue", { identifier: "ENG-2", labels: ["Feature"], removeLabels: ["Bug"], blockedBy: ["ENG-4"] }, "set edits"),
  s("move_issue", { identifier: "ENG-2", state: "In Progress" }),
  s("assign_issue", { identifier: "ENG-2", actor: "fictional-bot" }),
  s("claim_issue", { identifier: "ENG-4" }),
  s("update_project", { project: "Fictional Delivery", description: "Fictional delivery work" }),
  s("add_orchestration_profile", { name: "Fictional Nightly", configuration: builtinProfileInput().configuration }),
  s("set_default_orchestration_profile", { profile: "Fictional Review" }),
  s("archive_orchestration_profile", { profile: "Fictional Nightly" }),
  s("stop_run", (seed) => ({ run: seed.run, view: "summary" })),
  s("retry_run", (seed) => ({ run: seed.retryable, view: "summary" })),
  s("archive_run", (seed) => ({ run: seed.archivable })),
  s("cleanup_run", (seed) => ({ run: seed.cleanable, kind: "raw_logs", confirmed: true }))
];

/**
 * Tools the repeat-call harness cannot drive: most need a live engine participant or a verified
 * finalize phase. start_run needs a fresh preview fingerprint, so its output contract is driven by
 * its own test in tool-output-contracts.test.ts. Their hints are asserted as advertised values only.
 */
export const undrivableTools = ["start_run", "respond_to_run", "resolve_run_permission", "resume_run", "nudge_run", "publish_run"];
