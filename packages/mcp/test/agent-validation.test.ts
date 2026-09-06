import { expect, it } from "vitest";
import { createIssue, createIssueInputSchema, listActivity, updateIssueInputSchema } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

it("rejects typos, empty updates, aliases and invalid limits without issue changes", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Set up CI" });
    const before = listActivity(f.context, { issue: "ENG-1" });
    for (const args of [{ descripton: "typo" }, {}, { labels: [] }, { assignee: null, assigneeId: "unknown" }]) {
      const result = await f.call("update_issue", { identifier: "ENG-1", ...args });
      expect(result.error).toBe(true);
      expect(result.data.error.code).toBe("VALIDATION_FAILED");
    }
    for (const limit of [0, -1, 251, 1.5]) {
      expect((await f.call("list_issues", { limit })).error).toBe(true);
    }
    expect(listActivity(f.context, { issue: "ENG-1" })).toEqual(before);
    expect(() => f.cli(["issue", "update", "ENG-1", "--json"])).toThrow();
    expect(() => f.cli(["issue", "update", "ENG-1", "--descripton", "typo", "--json"])).toThrow();
    expect(() => f.cli(["issue", "list", "--limit", "0", "--json"])).toThrow();
    expect((await f.call("update_issue", { identifier: "ENG-1", description: null })).error).toBe(false);
  } finally { await f.close(); }
});

it("validates shared issue schemas before adapters", () => {
  expect(updateIssueInputSchema.safeParse({ descripton: "typo" }).success).toBe(false);
  expect(updateIssueInputSchema.safeParse({}).success).toBe(false);
  expect(createIssueInputSchema.safeParse({ title: "CI", team: "ENG", teamId: "id" }).success).toBe(false);
  expect(updateIssueInputSchema.safeParse({ description: null }).success).toBe(true);
});
