import { expect, it } from "vitest";
import {
  createIssue,
  createIssueInputSchema,
  createTemplate,
  getIssue,
  getTeamByKey,
  listActivity,
  updateIssueInputSchema
} from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

it("rejects typos, empty updates, aliases and invalid limits without issue changes", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Set up CI" });
    const before = listActivity(f.context, { issue: "ENG-1" });
    // The typo is paired with a valid field: a non-strict schema would strip `descripton`
    // and apply the title, so only strict validation makes this call fail.
    for (const args of [{ title: "Renamed", descripton: "typo" }, {}, { labels: [] }, { assignee: null, assigneeId: "unknown" }]) {
      const result = await f.call("update_issue", { identifier: "ENG-1", ...args });
      expect(result.error).toBe(true);
      expect(result.data.error.code).toBe("VALIDATION_FAILED");
    }
    for (const limit of [0, -1, 251, 1.5]) {
      const result = await f.call("list_issues", { limit });
      expect(result.error).toBe(true);
      expect(result.data.error.code).toBe("VALIDATION_FAILED");
    }
    expect(getIssue(f.context, "ENG-1").title).toBe("Set up CI");
    expect(listActivity(f.context, { issue: "ENG-1" })).toEqual(before);

    expect(f.cliError(["issue", "update", "ENG-1", "--json"]).code).toBe("VALIDATION_FAILED");
    expect(f.cliError(["issue", "list", "--limit", "0", "--json"]).code).toBe("VALIDATION_FAILED");
    expect((await f.call("update_issue", { identifier: "ENG-1", description: null })).error).toBe(false);
  } finally { await f.close(); }
});

it("rejects unknown keys on create, list and non-issue tools", async () => {
  const f = await agentFixture();
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["create_issue", { title: "Set up CI", priorty: 2 }],
      ["list_issues", { state: "Todo", asignee: "owner" }],
      ["list_saved_views", { bogus: true }],
      ["list_builtin_views", { bogus: true }],
      ["get_run_metrics", { bogus: true }]
    ];
    for (const [tool, args] of cases) {
      const result = await f.call(tool, args);
      expect(result.error, tool).toBe(true);
      expect(result.data.error.code, tool).toBe("VALIDATION_FAILED");
    }
    expect((await f.call("list_issues", {})).data.issues).toEqual([]);
  } finally { await f.close(); }
});

it("names the offending field in validation details", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Set up CI" });
    const conflict = await f.call("update_issue", { identifier: "ENG-1", assignee: "owner", assigneeId: "id" });
    expect(conflict.data.error.code).toBe("VALIDATION_FAILED");
    expect(conflict.data.error.details.issues[0].path).toEqual(["assignee"]);
    const typo = await f.call("update_issue", { identifier: "ENG-1", title: "x", descripton: "typo" });
    expect(typo.data.error.details.issues[0].keys).toEqual(["descripton"]);
  } finally { await f.close(); }
});

it("lets a template override its team or project by ID", async () => {
  const f = await agentFixture();
  try {
    createTemplate(f.context, { name: "bug", title: "Fix flaky build", team: "ENG" });
    const team = getTeamByKey(f.context, "ENG");
    const result = await f.call("create_issue_from_template", { name: "bug", overrides: { teamId: team.id } });
    expect(result.error).toBe(false);
    expect(result.data.identifier).toBe("ENG-1");

    const both = await f.call("create_issue_from_template", { name: "bug", overrides: { team: "ENG", teamId: team.id } });
    expect(both.error).toBe(true);
    expect(both.data.error.code).toBe("VALIDATION_FAILED");
  } finally { await f.close(); }
});

it("describes reference fields in the advertised tool schema", async () => {
  const f = await agentFixture();
  try {
    const { tools } = await f.client.listTools();
    const update = tools.find((tool) => tool.name === "update_issue")!;
    const properties = update.inputSchema.properties as Record<string, { description?: string }>;
    for (const field of ["assignee", "project", "cycle", "parent", "blocks", "removeLabels", "removeBlockedBy", "removeBlocks"]) {
      expect(properties[field]?.description, field).toBeTruthy();
    }
    expect(update.inputSchema.additionalProperties).toBe(false);
  } finally { await f.close(); }
});

it("validates shared issue schemas before adapters", () => {
  expect(updateIssueInputSchema.safeParse({ descripton: "typo" }).success).toBe(false);
  expect(updateIssueInputSchema.safeParse({}).success).toBe(false);
  expect(createIssueInputSchema.safeParse({ title: "CI", team: "ENG", teamId: "id" }).success).toBe(false);
  expect(updateIssueInputSchema.safeParse({ description: null }).success).toBe(true);
});
