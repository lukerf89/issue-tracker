import { expect, it } from "vitest";
import { archiveIssue, createIssue, createTeam, updateIssue } from "@issue-tracker/core";
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

it("continues mutable sorts with the right rows and stales only on moves", async () => {
  const f = await agentFixture();
  try {
    for (const priority of [3, 1, 3, 2]) createIssue(f.context, { title: `CI p${priority}`, priority });
    const ids = (page: { data: { issues: Array<{ identifier: string }> } }) => page.data.issues.map((row) => row.identifier);

    const search = await f.call("search", { query: "CI", limit: 1 });
    updateIssue(f.context, "ENG-2", { description: "Search results changed" });
    expect((await f.call("search", { query: "CI", cursor: search.data.nextCursor })).data.error.code).toBe("ISSUE_CURSOR_STALE");

    // Priority order: ENG-2 (1), ENG-4 (2), ENG-1 (3), ENG-3 (3).
    const first = await f.call("list_issues", { sort: "priority", limit: 2 });
    expect(ids(first)).toEqual(["ENG-2", "ENG-4"]);
    updateIssue(f.context, "ENG-1", { title: "Renamed without moving" });
    const second = await f.call("list_issues", { sort: "priority", limit: 2, cursor: first.data.nextCursor });
    expect(ids(second)).toEqual(["ENG-1", "ENG-3"]);
    updateIssue(f.context, "ENG-3", { priority: 1 });
    expect((await f.call("list_issues", { sort: "priority", cursor: first.data.nextCursor })).data.error.code).toBe("ISSUE_CURSOR_STALE");

    f.context.clock = { now: () => new Date("2026-01-05T00:00:00Z") };
    updateIssue(f.context, "ENG-4", { title: "Newest" });
    const recent = await f.call("list_issues", { sort: "updatedAt", limit: 2 });
    expect(ids(recent)).toEqual(["ENG-4", "ENG-1"]);
    expect(ids(await f.call("list_issues", { sort: "updatedAt", limit: 2, cursor: recent.data.nextCursor }))).toEqual(["ENG-2", "ENG-3"]);
    updateIssue(f.context, "ENG-3", { title: "Moved to the front" });
    expect((await f.call("list_issues", { sort: "updatedAt", cursor: recent.data.nextCursor })).data.error.code).toBe("ISSUE_CURSOR_STALE");

  } finally { await f.close(); }
});

it("reports team changes as stale and rejects cursors whose value does not fit the sort", async () => {
  const f = await agentFixture();
  try {
    for (let n = 1; n <= 3; n++) createIssue(f.context, { title: `CI ${n}` });
    const page = await f.call("list_issues", { limit: 1 });
    createTeam(f.context, { key: "OPS", name: "Operations" });
    expect((await f.call("list_issues", { limit: 1, cursor: page.data.nextCursor })).data.error.code).toBe("ISSUE_CURSOR_STALE");

    const priority = await f.call("list_issues", { sort: "priority", limit: 1 });
    const decoded = JSON.parse(Buffer.from(priority.data.nextCursor.slice(4), "base64url").toString());
    const tampered = "it1." + Buffer.from(JSON.stringify({ ...decoded, value: null })).toString("base64url");
    expect((await f.call("list_issues", { sort: "priority", cursor: tampered })).data.error.code).toBe("VALIDATION_FAILED");
  } finally { await f.close(); }
});
