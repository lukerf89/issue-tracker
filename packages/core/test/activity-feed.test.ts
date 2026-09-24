import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addComment,
  AppError,
  AppErrorCode,
  applyMigrations,
  archiveIssue,
  archiveProject,
  assignIssue,
  createActor,
  createIssue,
  createProject,
  createTeam,
  init,
  listActivity,
  listActivityPageInputSchema,
  listActivitySince,
  listActivitySinceInputSchema,
  listIssueActivityPage,
  openDb,
  serializeActivityFeed,
  serializeActivityPage,
  updateIssue,
  whoami,
  type ActivityFeed,
  type ActivityPage,
  type ListActivitySinceInput,
  type ServiceContext
} from "../src/index.js";

// Fictional data only. Covers LF-139: bounded incremental activity feed and paged history.

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function setup(now = "2026-01-01T00:00:00.000Z") {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-activity-"));
  tempDirs.push(tempDir);
  const db = openDb(join(tempDir, "tracker.db"));
  applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date(now) } };
  init(context);
  context.actor = whoami(context);
  return context;
}

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected AppError");
}

function drainFeed(context: ServiceContext, input: ListActivitySinceInput, start?: string) {
  const ids: string[] = [];
  let cursor = start;
  let pages = 0;
  for (;;) {
    const page: ActivityFeed = listActivitySince(context, { ...input, cursor });
    ids.push(...page.events.map((event) => event.id));
    cursor = page.cursor;
    pages += 1;
    if (!page.hasMore) return { ids, cursor, pages };
  }
}

function drainHistory(context: ServiceContext, issue: string, limit?: number) {
  const ids: string[] = [];
  let after: string | undefined;
  let pages = 0;
  for (;;) {
    const page: ActivityPage = listIssueActivityPage(context, { issue, after, limit });
    ids.push(...page.entries.map((entry) => entry.id));
    after = page.cursor;
    pages += 1;
    if (!page.hasMore) return { ids, pages };
  }
}

function allActivityIdsInRowidOrder(context: ServiceContext): string[] {
  return (context.db.$client
    .prepare("select id from activity order by rowid")
    .all() as Array<{ id: string }>).map((row) => row.id);
}

function maxRowid(context: ServiceContext): number {
  return (context.db.$client.prepare("select coalesce(max(rowid), 0) as m from activity").get() as { m: number }).m;
}

describe("activity feed", () => {
  it("returns an empty page on an empty log and guards cursors ahead of the log", () => {
    const context = setup();
    expect(maxRowid(context)).toBe(0);

    expect(listActivitySince(context)).toEqual({ events: [], cursor: "0", hasMore: false });
    expect(listActivitySince(context, { cursor: "0" })).toEqual({ events: [], cursor: "0", hasMore: false });

    const ahead = errorOf(() => listActivitySince(context, { cursor: "1" }));
    expect(ahead.code).toBe(AppErrorCode.VALIDATION_FAILED);
    expect(ahead.details).toEqual({ cursor: "1", latestCursor: "0" });
  });

  it("accepts a cursor equal to the latest rowid and rejects one past it", () => {
    const context = setup();
    createIssue(context, { title: "Set up CI", team: "ENG" });
    createIssue(context, { title: "Write docs", team: "ENG" });
    const latest = String(maxRowid(context));

    expect(listActivitySince(context, { cursor: latest })).toEqual({ events: [], cursor: latest, hasMore: false });
    const ahead = errorOf(() => listActivitySince(context, { cursor: String(Number(latest) + 1) }));
    expect(ahead.code).toBe(AppErrorCode.VALIDATION_FAILED);
    expect(ahead.details).toEqual({ cursor: String(Number(latest) + 1), latestCursor: latest });
  });

  it("computes hasMore exactly at the page boundary", () => {
    const context = setup();
    createIssue(context, { title: "Set up CI", team: "ENG" });
    createIssue(context, { title: "Write docs", team: "ENG" });
    createIssue(context, { title: "Fix lint", team: "ENG" });

    const exact = listActivitySince(context, { limit: 3 });
    expect(exact.events).toHaveLength(3);
    expect(exact.hasMore).toBe(false);

    const first = listActivitySince(context, { limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe(first.events[1]!.cursor);
    const second = listActivitySince(context, { limit: 2, cursor: first.cursor });
    expect(second.events).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it("defaults the feed to 100 and history to 50, and rejects limits outside 1..500", () => {
    const context = setup();
    createIssue(context, { title: "Set up CI", team: "ENG" });
    for (let index = 0; index < 110; index += 1) {
      addComment(context, { issue: "ENG-1", body: `Progress note ${index}` });
    }

    const feed = listActivitySince(context);
    expect(feed.events).toHaveLength(100);
    expect(feed.hasMore).toBe(true);
    const history = listIssueActivityPage(context, { issue: "ENG-1" });
    expect(history.entries).toHaveLength(50);
    expect(history.hasMore).toBe(true);

    for (const limit of [0, 501, 1.5]) {
      expect(errorOf(() => listActivitySince(context, { limit })).code).toBe(AppErrorCode.VALIDATION_FAILED);
      expect(errorOf(() => listIssueActivityPage(context, { issue: "ENG-1", limit })).code)
        .toBe(AppErrorCode.VALIDATION_FAILED);
      expect(listActivitySinceInputSchema.safeParse({ limit }).success).toBe(false);
      expect(listActivityPageInputSchema.safeParse({ issue: "ENG-1", limit }).success).toBe(false);
    }
    expect(listActivitySinceInputSchema.safeParse({ limit: 500 }).success).toBe(true);
    expect(listActivitySince(context, { limit: 500 }).events).toHaveLength(111);
  });

  it("traverses without gaps or duplicates while events are appended between pages", () => {
    const context = setup();
    for (let index = 1; index <= 5; index += 1) {
      createIssue(context, { title: `Seed task ${index}`, team: "ENG" });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let persistedMidway: string | undefined;
    let appended = 0;
    for (;;) {
      const page = listActivitySince(context, { cursor, limit: 2 });
      seen.push(...page.events.map((event) => event.id));
      cursor = page.cursor;
      if (persistedMidway === undefined) persistedMidway = cursor;
      if (appended < 3) {
        addComment(context, { issue: "ENG-1", body: `Appended during traversal ${appended}` });
        appended += 1;
      }
      if (!page.hasMore) break;
    }

    expect(seen).toEqual(allActivityIdsInRowidOrder(context));
    expect(new Set(seen).size).toBe(seen.length);

    // Resume from a cursor persisted after the first page: the rest matches exactly.
    const resumed = drainFeed(context, { limit: 3 }, persistedMidway);
    expect(resumed.ids).toEqual(allActivityIdsInRowidOrder(context).slice(2));
  });

  it("keeps archived issue events, including the archive event, in the feed and history", () => {
    const context = setup();
    createIssue(context, { title: "Retire old runner", team: "ENG" });
    archiveIssue(context, "ENG-1");

    const feed = listActivitySince(context, { issue: "ENG-1" });
    expect(feed.events.map((event) => event.action)).toEqual(["created", "archived"]);

    const history = listIssueActivityPage(context, { issue: "ENG-1" });
    expect(history.entries.map((entry) => entry.action)).toEqual(["created", "archived"]);
    expect(history.issue.identifier).toBe("ENG-1");
    expect(history.hasMore).toBe(false);
  });

  it("evaluates filters against current issue attributes and never replays events below the cursor", () => {
    const context = setup();
    const robo = createActor(context, { type: "agent", name: "Robo", handle: "robo" });
    createIssue(context, { title: "Set up CI", team: "ENG", assignee: "robo" });
    createIssue(context, { title: "Write docs", team: "ENG" });
    addComment(context, { issue: "ENG-1", body: "Robo started" });

    // Consumer filtered to robo reads ENG-1's events and its cursor passes ENG-2's creation.
    const first = listActivitySince(context, { assignee: "robo" });
    expect(first.events.map((event) => event.issueIdentifier)).toEqual(["ENG-1", "ENG-1"]);

    // ENG-2 moves INTO scope after the consumer passed its creation event.
    addComment(context, { issue: "ENG-2", body: "Before reassign" });
    const beforeAssign = maxRowid(context);
    assignIssue(context, "ENG-2", robo.id);
    const intoScope = listActivitySince(context, { assignee: "robo", cursor: first.cursor });
    // The comment is above the consumer's cursor and now in scope, so it is delivered; the
    // original "created" event is below the cursor and is never replayed.
    expect(intoScope.events.map((event) => [event.issueIdentifier, event.action])).toEqual([
      ["ENG-2", "commented"],
      ["ENG-2", "assigned"]
    ]);
    expect(Number(intoScope.events[0]!.cursor)).toBeLessThan(beforeAssign + 1);

    // ENG-1 moves OUT of scope: its unread events disappear from the filtered stream.
    addComment(context, { issue: "ENG-1", body: "Unread before unassign" });
    assignIssue(context, "ENG-1", null);
    const afterOut = listActivitySince(context, { assignee: "robo", cursor: intoScope.cursor });
    expect(afterOut.events).toEqual([]);
    // Unfiltered consumers still see them.
    expect(listActivitySince(context, { cursor: intoScope.cursor }).events.map((event) => event.action))
      .toEqual(["commented", "assigned"]);
  });

  it("applies the project filter to the current project and does not replay history", () => {
    const context = setup();
    createProject(context, { name: "Platform" });
    createIssue(context, { title: "Set up CI", team: "ENG", project: "Platform" });
    createIssue(context, { title: "Write docs", team: "ENG" });
    addComment(context, { issue: "ENG-1", body: "Platform progress" });
    const first = listActivitySince(context, { project: "Platform" });
    expect(first.events.map((event) => event.issueIdentifier)).toEqual(["ENG-1", "ENG-1"]);

    updateIssue(context, "ENG-2", { project: "Platform" });
    const next = listActivitySince(context, { project: "Platform", cursor: first.cursor });
    expect(next.events.map((event) => [event.issueIdentifier, event.action])).toEqual([["ENG-2", "updated"]]);

    updateIssue(context, "ENG-1", { project: null });
    // ENG-1 left the project: even its full history is now out of scope from cursor 0.
    expect(listActivitySince(context, { project: "Platform" }).events.map((event) => event.issueIdentifier))
      .toEqual(["ENG-2", "ENG-2"]);
  });

  it("scopes by team key and keeps unknown team/assignee lenient", () => {
    const context = setup();
    createTeam(context, { key: "OPS", name: "Operations" });
    createIssue(context, { title: "Set up CI", team: "ENG" });
    createIssue(context, { title: "Rotate keys", team: "OPS" });

    expect(listActivitySince(context, { team: "ops" }).events.map((event) => event.issueIdentifier)).toEqual(["OPS-1"]);
    expect(listActivitySince(context, { team: "NOPE" })).toEqual({ events: [], cursor: "0", hasMore: false });
    expect(listActivitySince(context, { assignee: "nobody" })).toEqual({ events: [], cursor: "0", hasMore: false });
  });

  it("resolves issue and project filters strictly by id or name, including archived ones", () => {
    const context = setup();
    const project = createProject(context, { name: "Platform" });
    const created = createIssue(context, { title: "Set up CI", team: "ENG", project: "Platform" });
    createIssue(context, { title: "Write docs", team: "ENG" });

    expect(listActivitySince(context, { issue: created.id }).events.map((event) => event.issueIdentifier)).toEqual(["ENG-1"]);
    expect(listActivitySince(context, { issue: "ENG-2" }).events.map((event) => event.issueIdentifier)).toEqual(["ENG-2"]);
    expect(errorOf(() => listActivitySince(context, { issue: "ENG-99" })).code).toBe(AppErrorCode.ISSUE_NOT_FOUND);

    expect(listActivitySince(context, { project: project.id }).events).toHaveLength(1);
    archiveProject(context, "Platform");
    expect(listActivitySince(context, { project: "Platform" }).events).toHaveLength(1);
    expect(errorOf(() => listActivitySince(context, { project: "Nowhere" })).code).toBe(AppErrorCode.PROJECT_NOT_FOUND);
  });

  it("rejects malformed cursors for both the feed and history", () => {
    const context = setup();
    createIssue(context, { title: "Set up CI", team: "ENG" });
    for (const bad of ["abc", "-1", "01", "1.5", "9007199254740993", -1]) {
      expect(errorOf(() => listActivitySince(context, { cursor: bad })).code).toBe(AppErrorCode.VALIDATION_FAILED);
      expect(errorOf(() => listIssueActivityPage(context, { issue: "ENG-1", after: bad })).code)
        .toBe(AppErrorCode.VALIDATION_FAILED);
      expect(listActivitySinceInputSchema.safeParse({ cursor: bad }).success).toBe(false);
      expect(listActivityPageInputSchema.safeParse({ issue: "ENG-1", after: bad }).success).toBe(false);
    }
    expect(listActivitySinceInputSchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(listActivityPageInputSchema.safeParse({ issue: "ENG-1", after: "" }).success).toBe(false);
    expect(errorOf(() => listIssueActivityPage(context, { issue: "ENG-1", after: "5000" })).details)
      .toEqual({ after: "5000", latestCursor: String(maxRowid(context)) });
  });

  it("rejects full combined with after or limit in the shared page schema", () => {
    expect(listActivityPageInputSchema.safeParse({ issue: "ENG-1", full: true }).success).toBe(true);
    expect(listActivityPageInputSchema.safeParse({ issue: "ENG-1", full: true, after: "1" }).success).toBe(false);
    expect(listActivityPageInputSchema.safeParse({ issue: "ENG-1", full: true, limit: 5 }).success).toBe(false);
    expect(listActivityPageInputSchema.safeParse({ issue: "ENG-1", after: "1", limit: 5 }).success).toBe(true);
  });
});

describe("paged issue history", () => {
  it("pages more than 50 entries with the default limit and ends with hasMore false", () => {
    const context = setup();
    createIssue(context, { title: "Set up CI", team: "ENG" });
    createIssue(context, { title: "Unrelated", team: "ENG" });
    for (let index = 0; index < 60; index += 1) {
      addComment(context, { issue: index % 2 === 0 ? "ENG-1" : "ENG-2", body: `Note ${index}` });
    }
    for (let index = 0; index < 30; index += 1) {
      addComment(context, { issue: "ENG-1", body: `More ${index}` });
    }

    const traversal = drainHistory(context, "ENG-1");
    expect(traversal.pages).toBe(2);
    expect(traversal.ids).toEqual(listActivity(context, { issue: "ENG-1" }).map((entry) => entry.id));
    expect(traversal.ids).toHaveLength(61);
  });

  it("returns an empty page with the cursor echoed for an issue without later entries", () => {
    const context = setup();
    createIssue(context, { title: "Set up CI", team: "ENG" });
    createIssue(context, { title: "Write docs", team: "ENG" });
    const firstEntry = listIssueActivityPage(context, { issue: "ENG-1" });
    const page = listIssueActivityPage(context, { issue: "ENG-1", after: firstEntry.cursor });
    expect(page).toMatchObject({ entries: [], cursor: firstEntry.cursor, hasMore: false });
    expect(errorOf(() => listIssueActivityPage(context, { issue: "ENG-99" })).code).toBe(AppErrorCode.ISSUE_NOT_FOUND);
  });

  it("orders paged history by append order while full history keeps createdAt order", () => {
    const context = setup("2026-01-01T00:10:00.000Z");
    createIssue(context, { title: "Set up CI", team: "ENG" });
    context.clock = { now: () => new Date("2026-01-01T00:05:00.000Z") };
    addComment(context, { issue: "ENG-1", body: "Clock went backwards" });
    context.clock = { now: () => new Date("2026-01-01T00:05:00.000Z") };
    addComment(context, { issue: "ENG-1", body: "Tied timestamp" });

    const appendOrder = allActivityIdsInRowidOrder(context);
    expect(drainHistory(context, "ENG-1", 1).ids).toEqual(appendOrder);
    expect(listActivity(context, { issue: "ENG-1" }).map((entry) => entry.id))
      .toEqual([appendOrder[1], appendOrder[2], appendOrder[0]]);
  });

  it("serializes feed and page envelopes with camelCase keys and cursors", () => {
    const context = setup();
    createIssue(context, { title: "Set up CI", team: "ENG" });
    const feed = serializeActivityFeed(listActivitySince(context));
    expect(Object.keys(feed)).toEqual(["events", "cursor", "hasMore"]);
    expect(feed.events[0]).toMatchObject({ cursor: "1", issueIdentifier: "ENG-1", action: "created" });

    const page = serializeActivityPage(listIssueActivityPage(context, { issue: "ENG-1" }));
    expect(Object.keys(page)).toEqual(["issue", "entries", "cursor", "hasMore"]);
    expect(page.issue).toEqual({ id: expect.any(String), identifier: "ENG-1" });
    expect(page.entries[0]).toMatchObject({ cursor: "1", action: "created", createdAt: "2026-01-01T00:00:00.000Z" });
  });
});
