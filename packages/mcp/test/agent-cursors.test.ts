import { expect, it } from "vitest";
import { archiveIssue, createIssue, updateIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

it("continues after archiving earlier results and binds cursors to query semantics", async () => {
  const f = await agentFixture();
  try {
    for (let n = 1; n <= 6; n++) createIssue(f.context, { title: `CI ${n}` });
    const first = await f.call("list_issues", { team: "ENG", limit: 2 });
    expect(first.data.nextCursor).toMatch(/^it1\./);
    archiveIssue(f.context, "ENG-1");
    const second = JSON.parse(f.cli(["issue", "list", "--team", "ENG", "--limit", "2", "--cursor", first.data.nextCursor, "--json"]));
    expect(second.issues.map((row: { identifier: string }) => row.identifier)).toEqual(["ENG-3", "ENG-4"]);
    createIssue(f.context, { title: "CI 7" });
    const final = await f.call("list_issues", { team: "ENG", limit: 10, cursor: second.nextCursor });
    expect(final.data.issues.map((row: { identifier: string }) => row.identifier)).toEqual(["ENG-5", "ENG-6", "ENG-7"]);
    expect(final.data.nextCursor).toBeNull();
    for (const args of [{ team: "ENG", priority: 4, cursor: first.data.nextCursor }, { team: "ENG", cursor: "it1.garbage" }]) {
      expect((await f.call("list_issues", args)).data.error.code).toBe("VALIDATION_FAILED");
    }
    expect((await f.call("search", { query: "CI", team: "ENG", cursor: first.data.nextCursor })).error).toBe(true);
    // Numeric offsets remain an explicitly legacy input bridge, but output is opaque.
    expect((await f.call("list_issues", { limit: 1, cursor: "1" })).data.nextCursor).toMatch(/^it1\./);
  } finally { await f.close(); }
});

it("invalidates relevance and mutable-sort cursors when results change", async () => {
  const f = await agentFixture();
  try {
    for (let n = 1; n <= 4; n++) createIssue(f.context, { title: `CI ${n}`, priority: 3 });
    for (const sort of ["priority", "updatedAt"] as const) {
      const first = await f.call("list_issues", { sort, limit: 1 });
      expect((await f.call("list_issues", { sort, limit: 1, cursor: first.data.nextCursor })).error).toBe(false);
      updateIssue(f.context, "ENG-4", { title: `Changed ${sort}` });
      expect((await f.call("list_issues", { sort, cursor: first.data.nextCursor })).data.error.code).toBe("ISSUE_CURSOR_STALE");
    }
    const search = await f.call("search", { query: "CI", limit: 1 });
    updateIssue(f.context, "ENG-2", { title: "Different text" });
    expect((await f.call("search", { query: "CI", cursor: search.data.nextCursor })).data.error.code).toBe("ISSUE_CURSOR_STALE");
  } finally { await f.close(); }
});
