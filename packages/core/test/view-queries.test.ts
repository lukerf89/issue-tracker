import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, archiveIssue, createActor, createIssue, createSavedView, init, listIssuesPageWithView, listIssuesWithView, moveIssue, openDb, resolveSavedView, updateIssue, type ServiceContext } from "../src/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "view-queries-"));
  const db = openDb(join(dir, "tracker.db"));
  applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date("2026-01-01T00:00:00Z") } };
  context.actor = init(context).actor;
  return { context, close() { db.$client.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("built-in and saved query semantics", () => {
  it("defines open states, human ownership, archive scope and recent ordering", () => {
    const { context, close } = fixture();
    try {
      const mine = createIssue(context, { title: "Cursor mine", assignee: context.actor!.id });
      const unassigned = createIssue(context, { title: "Cursor unassigned" });
      const done = createIssue(context, { title: "Cursor completed", assignee: context.actor!.id });
      moveIssue(context, done.identifier, "Done");
      const archived = createIssue(context, { title: "Cursor archived", assignee: context.actor!.id });
      archiveIssue(context, archived.identifier);
      const ids = (view: string) => listIssuesWithView(context, { view }).map(issue => issue.id);
      expect(ids("builtin:my-open")).toEqual([mine.id]);
      expect(ids("builtin:all-open")).toEqual([mine.id, unassigned.id]);
      expect(ids("builtin:unassigned")).toEqual([unassigned.id]);
      context.clock = { now: () => new Date("2026-01-02T00:00:00Z") };
      updateIssue(context, unassigned.identifier, { description: "Updated later" });
      expect(ids("builtin:recent")).toEqual([unassigned.id, mine.id, done.id]);
      expect(listIssuesPageWithView(context, { view: "builtin:recent", filters: { query: "cursor", limit: 1 } }).rows[0]?.issue.id).toBe(unassigned.id);
      context.actor = createActor(context, { name: "Build Agent", handle: "build", type: "agent" });
      expect(() => resolveSavedView(context, "builtin:my-open")).toThrow("current human actor");
      context.actor = null;
      expect(ids("builtin:my-open")).toEqual([mine.id]);
    } finally { close(); }
  });

  it.each(["Backlog", "Todo", "In Progress", "Blocked", "Done", "Canceled"])("defines membership for workflow %s", state => {
    const { context, close } = fixture();
    try {
      const issue = createIssue(context, { title: "Test workflow", assignee: context.actor!.id });
      moveIssue(context, issue.identifier, state);
      const expected = ["Done", "Canceled"].includes(state) ? [] : [issue.id];
      expect(listIssuesWithView(context, { view: "builtin:my-open" }).map(row => row.id)).toEqual(expected);
      expect(listIssuesWithView(context, { view: "builtin:all-open" }).map(row => row.id)).toEqual(expected);
    } finally { close(); }
  });

  it("roundtrips supported search, sort and workflow constraints with pagination", () => {
    const { context, close } = fixture();
    try {
      const first = createIssue(context, { title: "Cursor first" });
      const second = createIssue(context, { title: "Cursor second" });
      createIssue(context, { title: "Other issue" });
      context.clock = { now: () => new Date("2026-01-03T00:00:00Z") };
      updateIssue(context, second.identifier, { description: "Recent" });
      const filters = { query: "cursor", sort: "updatedAt" as const, stateTypes: ["unstarted" as const] };
      createSavedView(context, { name: "Cursor queue", filters });
      expect(resolveSavedView(context, "Cursor queue")).toEqual(filters);
      const page = listIssuesPageWithView(context, { view: "Cursor queue", filters: { limit: 1 } });
      expect(page.rows.map(row => row.issue.id)).toEqual([second.id]);
      expect(listIssuesPageWithView(context, { view: "Cursor queue", filters: { limit: 1 }, cursor: page.nextCursor! }).rows.map(row => row.issue.id)).toEqual([first.id]);
      expect(() => createSavedView(context, { name: "Bad", filters: { unsupported: true } as never })).toThrow();
      expect(() => createSavedView(context, { name: "builtin:recent", filters: {} })).toThrow("reserved");
    } finally { close(); }
  });
});
