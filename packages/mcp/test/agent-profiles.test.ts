import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTemplate, toolGroups } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

const builtCliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/index.js");

// Exact membership: a tool moving between groups, or dropping out of one, fails here
// instead of silently changing what agents are offered.
const CODING_TOOLS = [
  "assign_issue",
  "claim_issue",
  "comment_on_issue",
  "create_issue",
  "create_issue_from_template",
  "describe",
  "get_issue",
  "get_issues",
  "link_issue",
  "list_builtin_views",
  "list_issues",
  "list_saved_views",
  "list_templates",
  "move_issue",
  "read_issue_section",
  "search",
  "update_issue",
  "whoami"
];
const ORCHESTRATION_ONLY_TOOLS = [
  "add_orchestration_profile",
  "add_repository",
  "archive_orchestration_profile",
  "archive_repository",
  "archive_run",
  "associate_repository",
  "cleanup_run",
  "get_engine",
  "get_orchestration_profile",
  "get_repository",
  "get_run",
  "get_run_metrics",
  "list_engines",
  "list_orchestration_profiles",
  "list_repositories",
  "list_run_artifacts",
  "list_run_events",
  "list_run_records",
  "list_runs",
  "nudge_run",
  "preview_run",
  "publish_run",
  "resolve_run_permission",
  "respond_to_run",
  "resume_run",
  "retry_run",
  "set_default_orchestration_profile",
  "start_run",
  "stop_run",
  "validate_engines"
];

it("advertises registration-defined profiles while retaining aliases and normal coding calls", async () => {
  const full = await agentFixture();
  const coding = await agentFixture({ toolProfile: "coding" });
  const orchestration = await agentFixture({ toolProfile: "orchestration" });
  try {
    const all = (await full.client.listTools()).tools;
    const small = (await coding.client.listTools()).tools;
    const validGroups = ["coding", "orchestration", "admin"];
    for (const tool of all) {
      const groups = tool._meta?.["issue-tracker/groups"] as string[] | undefined;
      expect(groups?.length, tool.name).toBeGreaterThan(0);
      expect(groups!.every((group) => validGroups.includes(group)), tool.name).toBe(true);
    }
    expect(small.map((tool) => tool.name).sort()).toEqual(CODING_TOOLS);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(Buffer.byteLength(JSON.stringify(all)) * 0.65);
    expect(small.map((tool) => tool.name)).not.toContain("get_current_actor");
    expect((await coding.call("get_current_actor", {})).data).toEqual((await coding.call("whoami", {})).data);
    const created = await coding.call("create_issue", { title: "Set up CI", response: "compact" });
    expect(created.error).toBe(false);
    const found = await coding.call("search", { query: "CI", limit: 1 });
    expect(found.data.issues[0].identifier).toBe(created.data.identifier);
    expect((await coding.call("claim_issue", { identifier: created.data.identifier })).error).toBe(false);
    expect((await coding.call("move_issue", { identifier: created.data.identifier, state: "In Progress", response: "compact" })).error).toBe(false);
    expect((await coding.call("comment_on_issue", { issue: created.data.identifier, body: "Verified" })).error).toBe(false);
    // Coding agents can apply a template and release their own claim with advertised tools.
    createTemplate(coding.context, { name: "bug", title: "Fix flaky build", team: "ENG" });
    expect((await coding.call("create_issue_from_template", { name: "bug" })).error).toBe(false);
    const released = await coding.call("assign_issue", { identifier: created.data.identifier, actor: null });
    expect(released.data.assigneeId).toBe(null);
    const orchestrated = (await orchestration.client.listTools()).tools.map((tool) => tool.name).sort();
    expect(orchestrated).toEqual([...CODING_TOOLS, ...ORCHESTRATION_ONLY_TOOLS].sort());
    // Native CLI stdio startup uses the same profile; this also exercises transport forwarding.
    const client = new Client({ name: "profile-cli-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [builtCliPath, "--db", coding.dbPath, "mcp", "--agent", "build-agent", "--tool-profile", "coding"] }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(small.map((tool) => tool.name));
      const resources = await client.listResourceTemplates();
      expect(resources.resourceTemplates.length).toBeGreaterThan(0);
    } finally { await client.close(); }
  } finally { await full.close(); await coding.close(); await orchestration.close(); }
});

it("rejects unknown groups, empty group lists and unknown profiles", async () => {
  expect(() => toolGroups("codng" as never)).toThrow();
  expect(() => (toolGroups as (...groups: string[]) => unknown)()).toThrow();
  const f = await agentFixture();
  try {
    expect(f.cliError(["mcp", "--tool-profile", "tiny"]).code).toBe("VALIDATION_FAILED");
  } finally { await f.close(); }
});
