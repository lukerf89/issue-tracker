import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  addAttachment,
  addComment,
  AppErrorCode,
  applyMigrations,
  archiveLabel,
  createActor,
  createCycle,
  createIssue,
  createLabel,
  createTeam,
  getIssue,
  init,
  listIssues,
  listIssuesPage,
  listStates,
  openDb,
  searchIssues,
  searchIssuesPage,
  serializeIssueSummary,
  updateIssue,
  whoami,
  type Clock,
  type Db,
  type IssuePage,
  type IssueProjectionField,
  type ListIssueFilters,
  type ServiceContext
} from "../src/index.js";

// Fictional data only. Covers LF-143: search filtering/ranking/pagination in SQL, and
// page projection that loads only the requested relations with batched queries.

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const RELATION_FIELDS: IssueProjectionField[] = [
  "labels", "parent", "children", "blockedBy", "blocks", "stateName", "stateType", "assigneeHandle"
];

describe("search pagination in SQL", () => {
  it("composes combined filters with search and pages without gaps or duplicates", () => {
    const { context, close } = initializedContext();
    try {
      seedCombinedFilterFixture(context);
      const filters = {
        query: "gizmo", label: "backend", stateTypes: ["unstarted"], state: "Todo",
        assignee: "robo", priority: 2, cycle: 1
      } satisfies Partial<ListIssueFilters> & { query: string };

      expect(ids(searchIssues(context, { ...filters, sort: "identifier" }))).toEqual(["ENG-1", "ENG-6", "OPS-1"]);
      expect(ids(searchIssues(context, { ...filters, team: "ENG", sort: "identifier" }))).toEqual(["ENG-1", "ENG-6"]);
      expect(ids(searchIssues(context, { ...filters, sort: "priority" }))).toEqual(["ENG-1", "ENG-6", "OPS-1"]);

      for (const sort of [undefined, "identifier", "priority", "updatedAt"] as const) {
        const unpaged = ids(searchIssues(context, { query: "gizmo", sort }));
        expect(unpaged).toHaveLength(7);
        expect(pageAll((cursor) => searchIssuesPage(context, { query: "gizmo", sort, limit: 2 }, { cursor }))).toEqual(unpaged);
        const filteredUnpaged = ids(searchIssues(context, { ...filters, sort }));
        expect(filteredUnpaged.slice().sort()).toEqual(["ENG-1", "ENG-6", "OPS-1"]);
        expect(pageAll((cursor) => searchIssuesPage(context, { ...filters, sort, limit: 2 }, { cursor }))).toEqual(filteredUnpaged);
      }

      // Filters that can match nothing keep returning empty results on list and search.
      for (const empty of [{ label: "no-such-label" }, { stateTypes: [] }, { cycle: randomUUID() }, { label: "legacy" }] as ListIssueFilters[]) {
        expect(searchIssues(context, { query: "gizmo", ...empty })).toEqual([]);
        expect(searchIssuesPage(context, { query: "gizmo", ...empty }).rows).toEqual([]);
        expect(listIssues(context, empty)).toEqual([]);
        expect(listIssuesPage(context, empty).rows).toEqual([]);
      }
      // A cycle number shared by teams matches every team's cycle unless a team scopes it.
      expect(ids(listIssues(context, { cycle: 1, label: "backend", sort: "identifier" }))).toEqual(["ENG-1", "ENG-2", "ENG-4", "ENG-6", "ENG-7", "OPS-1"]);
      expect(ids(listIssues(context, { cycle: 1, team: "OPS" }))).toEqual(["OPS-1"]);
    } finally {
      close();
    }
  });

  it("keeps relevance weights, prefix/AND semantics, tie order, and page snippets", () => {
    const { context, close } = initializedContext();
    try {
      createIssue(context, { title: "Unrelated body", description: "mentions the sprocket in passing" });
      createIssue(context, { title: "Sprocket calibration" });
      for (let index = 0; index < 5; index++) {
        createIssue(context, { title: `Duplicate ticket`, description: `Filler text then the sprocket appears late in paragraph ${index}` });
      }

      const ranked = ids(searchIssues(context, { query: "sprocket" }));
      expect(ranked[0]).toBe("ENG-2");
      expect(ids(searchIssues(context, { query: "sprock" }))).toEqual(ranked);
      expect(ids(searchIssues(context, { query: "sprocket calibration" }))).toEqual(["ENG-2"]);
      // Identical content ⇒ equal bm25 ⇒ ties follow fts rowid (creation order).
      expect(ids(searchIssues(context, { query: "duplicate" }))).toEqual(["ENG-3", "ENG-4", "ENG-5", "ENG-6", "ENG-7"]);

      const pages: IssuePage[] = [];
      let cursor: string | undefined;
      do {
        const page = searchIssuesPage(context, { query: "sprocket", limit: 2 }, { cursor });
        pages.push(page);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(pages.length).toBeGreaterThanOrEqual(3);
      expect(pages.flatMap((page) => page.rows.map((row) => row.issue.identifier))).toEqual(ranked);
      for (const page of pages) {
        for (const row of page.rows) {
          expect(row.snippet?.toLowerCase()).toContain("sprocket");
        }
      }
    } finally {
      close();
    }
  });

  it("invalidates search cursors on edits, new matches, and pure reorders", () => {
    const { context, db, close } = initializedContext();
    try {
      for (let index = 0; index < 4; index++) createIssue(context, { title: "Duplicate ticket", priority: 2 });
      const first = (sort?: "priority") => searchIssuesPage(context, { query: "duplicate", limit: 1, sort });
      const next = (page: IssuePage, sort?: "priority") =>
        searchIssuesPage(context, { query: "duplicate", limit: 1, sort }, { cursor: page.nextCursor ?? undefined });

      // Unchanged results: the cursor continues.
      expect(next(first()).rows.map((row) => row.issue.identifier)).toEqual(["ENG-2"]);
      // Legacy numeric offsets still work.
      expect(searchIssuesPage(context, { query: "duplicate", limit: 1 }, { cursor: "2" }).rows.map((row) => row.issue.identifier)).toEqual(["ENG-3"]);

      let page = first();
      updateIssue(context, "ENG-3", { title: "Duplicate ticket revised" });
      expect(() => next(page)).toThrowAppError(AppErrorCode.ISSUE_CURSOR_STALE);

      page = first();
      createIssue(context, { title: "Duplicate ticket" });
      expect(() => next(page)).toThrowAppError(AppErrorCode.ISSUE_CURSOR_STALE);

      // A touch that bumps no revision still moves the row's fts rowid, reordering the
      // equal-rank tie. The ordered snapshot must catch it rather than skip or repeat rows.
      page = first();
      const revisionBefore = getIssue(context, "ENG-1").revision;
      db.$client.prepare("update issues set updated_at = updated_at where identifier = 'ENG-1'").run();
      expect(getIssue(context, "ENG-1").revision).toBe(revisionBefore);
      expect(ids(searchIssues(context, { query: "duplicate" }))[0]).not.toBe("ENG-1");
      expect(() => next(page)).toThrowAppError(AppErrorCode.ISSUE_CURSOR_STALE);

      page = first("priority");
      updateIssue(context, "ENG-4", { priority: 1 });
      expect(() => next(page, "priority")).toThrowAppError(AppErrorCode.ISSUE_CURSOR_STALE);
    } finally {
      close();
    }
  });

  it("returns full-detail rows from non-paged search and applies the limit in SQL", () => {
    const { context, close } = initializedContext();
    try {
      seedCombinedFilterFixture(context);
      addComment(context, { issue: "ENG-1", body: "A fictional note." });
      addAttachment(context, { issue: "ENG-1", kind: "link", title: "Spec", url: "https://example.com/spec" });

      const [hit] = searchIssues(context, { query: "alpha" });
      expect(hit).toEqual(getIssue(context, "ENG-1"));
      expect(hit?.comments.map((comment) => comment.body)).toEqual(["A fictional note."]);
      expect(hit?.attachments).toHaveLength(1);

      const all = ids(searchIssues(context, { query: "gizmo", sort: "identifier" }));
      expect(ids(searchIssues(context, { query: "gizmo", sort: "identifier", limit: 2 }))).toEqual(all.slice(0, 2));
      expect(searchIssues(context, { query: "gizmo", limit: 0 })).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("page projection loads only requested relations", () => {
  it("projects relations and readable fields identical to getIssue on list and search pages", () => {
    const { context, close } = initializedContext();
    try {
      seedCombinedFilterFixture(context);
      const pages = [
        listIssuesPage(context, { sort: "identifier", limit: 250 }, { fields: RELATION_FIELDS }),
        searchIssuesPage(context, { query: "gizmo", limit: 250 }, { fields: RELATION_FIELDS })
      ];

      for (const page of pages) {
        expect(page.rows.length).toBeGreaterThan(0);
        for (const row of page.rows) {
          const detail = getIssue(context, row.issue.identifier);
          const projected = row.issue as unknown as Record<string, unknown>;
          const state = listStates(context, detail.teamId).find((candidate) => candidate.id === detail.stateId)!;
          for (const key of ["labels", "parent", "children", "blockedBy", "blocks"] as const) {
            expect(projected[key], `${row.issue.identifier}.${key}`).toEqual(detail[key]);
          }
          expect(projected.stateName).toBe(state.name);
          expect(projected.stateType).toBe(state.type);
          expect(projected.assigneeHandle).toBe(detail.assigneeId ? "robo" : null);
          // Comments and attachments are never part of a page row.
          expect("comments" in projected).toBe(false);
          expect("attachments" in projected).toBe(false);
        }
      }

      // The fixture exercises empty and populated relations plus ordering.
      const eng1 = getIssue(context, "ENG-1");
      expect(eng1.children.length).toBeGreaterThan(1);
      expect(eng1.blockedBy.length).toBeGreaterThan(1);
      expect(eng1.labels.map((label) => label.name)).toEqual(["backend"]); // archived "legacy" excluded
      const eng3 = getIssue(context, "ENG-3");
      expect(eng3.labels).toEqual([]);
      expect(getIssue(context, "ENG-4").assigneeId).toBeNull();
      expect(getIssue(context, "ENG-7").parent).toBeNull();
    } finally {
      close();
    }
  });

  it("omits unrequested relation keys from page rows and keeps the serialized summary shape", () => {
    const { context, close } = initializedContext();
    try {
      seedCombinedFilterFixture(context);
      addComment(context, { issue: "ENG-1", body: "A fictional note." });

      for (const page of [
        listIssuesPage(context, { sort: "identifier" }, { fields: ["labels"] }),
        searchIssuesPage(context, { query: "alpha" }, { fields: ["labels"] })
      ]) {
        const row = page.rows.find((candidate) => candidate.issue.identifier === "ENG-1")!;
        const issue = row.issue as unknown as Record<string, unknown>;
        for (const key of ["children", "blockedBy", "blocks", "parent", "comments", "commentCount", "attachments", "stateName"]) {
          expect(key in issue, key).toBe(false);
        }
        expect(Object.keys(serializeIssueSummary(row.issue, row.fields))).toEqual([
          "identifier", "title", "stateId", "priority", "assigneeId", "updatedAt", "labels"
        ]);
        expect(serializeIssueSummary(row.issue, row.fields).labels).toEqual([
          expect.objectContaining({ name: "backend" })
        ]);
      }
    } finally {
      close();
    }
  });
});

describe("bounded work on large fixtures", () => {
  it("keeps statement counts and bind lists independent of match/page size", () => {
    const { context, db, close } = initializedContext();
    try {
      seedLargeFixture(context, db);
      const spy = spyStatements(db);
      try {
        const scenarios: Array<{ name: string; run: (limit: number) => IssuePage }> = [
          { name: "list", run: (limit) => listIssuesPage(context, { limit }, { fields: RELATION_FIELDS }) },
          { name: "search", run: (limit) => searchIssuesPage(context, { query: "widget", limit }, { fields: RELATION_FIELDS }) },
          {
            name: "list+filters",
            run: (limit) => listIssuesPage(context, { limit, label: "common", stateTypes: ["unstarted"], state: "Todo", cycle: 1 }, { fields: RELATION_FIELDS })
          },
          {
            name: "search+filters",
            run: (limit) => searchIssuesPage(context, { query: "widget", limit, label: "common", stateTypes: ["unstarted"], state: "Todo", cycle: 1, sort: "priority" }, { fields: RELATION_FIELDS })
          }
        ];

        for (const scenario of scenarios) {
          const counts: number[] = [];
          for (const limit of [5, 50]) {
            spy.log.length = 0;
            const page = scenario.run(limit);
            expect(page.rows, scenario.name).toHaveLength(limit);
            expect(page.nextCursor, scenario.name).not.toBeNull();
            // Every measured row really has each relation populated.
            for (const row of page.rows.slice(1, -1)) {
              const issue = row.issue as unknown as Record<string, unknown[] | object | null>;
              expect(issue.parent, scenario.name).not.toBeNull();
              for (const key of ["labels", "children", "blockedBy", "blocks"]) {
                expect((issue[key] as unknown[]).length, `${scenario.name}.${key}`).toBeGreaterThan(0);
              }
            }
            counts.push(spy.log.length);
            expect(spy.log.some((entry) => /\b(comments|attachments)\b/i.test(entry.sql)), scenario.name).toBe(false);
            // Only the page-id list may grow, and only with the page size (never with the
            // 600 matches, 33 teams' states, or 33 same-numbered cycles).
            const maxBinds = Math.max(...spy.log.map((entry) => entry.params));
            expect(maxBinds, `${scenario.name} limit ${limit}`).toBeLessThanOrEqual(limit === 5 ? 20 : limit + 20);
          }
          expect(counts[0], scenario.name).toBe(counts[1]);
          expect(counts[1], scenario.name).toBeLessThanOrEqual(16);
        }

        // A second search page reuses the same bounded plan.
        const firstPage = searchIssuesPage(context, { query: "widget", limit: 5 }, { fields: RELATION_FIELDS });
        spy.log.length = 0;
        const second = searchIssuesPage(context, { query: "widget", limit: 5 }, { cursor: firstPage.nextCursor ?? undefined, fields: RELATION_FIELDS });
        expect(second.rows).toHaveLength(5);
        expect(second.rows.every((row) => row.snippet?.toLowerCase().includes("widget"))).toBe(true);
        expect(Math.max(...spy.log.map((entry) => entry.params))).toBeLessThanOrEqual(20);
      } finally {
        spy.restore();
      }
    } finally {
      close();
    }
  });
});

declare module "vitest" {
  interface Assertion {
    toThrowAppError(code: string): void;
  }
}

expect.extend({
  toThrowAppError(received: () => unknown, code: string) {
    try {
      received();
    } catch (error) {
      const actual = (error as { code?: unknown }).code;
      return { pass: actual === code, message: () => `expected error code ${code}, got ${String(actual)}` };
    }
    return { pass: false, message: () => `expected error code ${code}, but nothing was thrown` };
  }
});

function ids(rows: Array<{ identifier: string }>): string[] {
  return rows.map((row) => row.identifier);
}

function pageAll(fetch: (cursor: string | undefined) => IssuePage): string[] {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = fetch(cursor);
    seen.push(...page.rows.map((row) => row.issue.identifier));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return seen;
}

function seedCombinedFilterFixture(context: ServiceContext): void {
  createTeam(context, { key: "OPS", name: "Operations" });
  createActor(context, { type: "agent", name: "Robo Worker", handle: "robo" });
  createLabel(context, { name: "backend" });
  createLabel(context, { name: "legacy" });
  createCycle(context, { team: "ENG", number: 1 });
  createCycle(context, { team: "OPS", number: 1 });

  const base = { team: "ENG", labels: ["backend"], state: "Todo", assignee: "robo", priority: 2, cycle: 1 } as const;
  createIssue(context, { ...base, title: "Gizmo alpha", labels: ["backend", "legacy"] }); // ENG-1
  createIssue(context, { ...base, title: "Gizmo beta", state: "In Progress", priority: 1, parent: "ENG-1" }); // ENG-2
  createIssue(context, { ...base, title: "Gizmo gamma", labels: [], parent: "ENG-1" }); // ENG-3
  createIssue(context, { ...base, title: "Gizmo delta", assignee: null, blocks: ["ENG-1"] }); // ENG-4
  createIssue(context, { ...base, title: "Gizmo epsilon", priority: 3, cycle: null, blockedBy: ["ENG-1"] }); // ENG-5
  createIssue(context, { ...base, title: "Gizmo zeta" }); // ENG-6
  createIssue(context, { ...base, title: "Unrelated chore" }); // ENG-7
  createIssue(context, { ...base, team: "OPS", title: "Gizmo ops runbook", parent: "ENG-1", blocks: ["ENG-1"] }); // OPS-1
  archiveLabel(context, "legacy");
}

// ~600 matching issues across three teams, every one with labels, a parent, children,
// blockers and blocked issues, plus comments/attachments that page reads must not touch.
// 30 extra empty teams multiply workflow states and same-numbered cycles.
function seedLargeFixture(context: ServiceContext, db: Db): void {
  const actor = context.actor!;
  const teamKeys = ["ENG", "OPS", "QAT"];
  createTeam(context, { key: "OPS", name: "Operations" });
  createTeam(context, { key: "QAT", name: "Quality" });
  for (let index = 0; index < 30; index++) {
    createTeam(context, { key: `X${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`, name: `Extra ${index}` });
  }
  const common = createLabel(context, { name: "common" });
  const secondary = createLabel(context, { name: "secondary" });
  const allTeams = db.$client.prepare("select id, key from teams").all() as Array<{ id: string; key: string }>;
  const cycleByTeam = new Map(allTeams.map((team) => [team.key, createCycle(context, { team: team.key, number: 1 }).id]));

  const client = db.$client;
  const now = "2026-01-01T00:00:00.000Z";
  const insertIssue = client.prepare(`insert into issues (id, identifier, team_id, number, title, description, state_id, priority,
    assignee_id, creator_id, cycle_id, parent_id, sort_order, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
  const insertLabel = client.prepare("insert into issue_labels (issue_id, label_id) values (?, ?)");
  const insertDependency = client.prepare("insert into issue_dependencies (blocking_issue_id, blocked_issue_id, created_at) values (?, ?, ?)");
  const insertComment = client.prepare("insert into comments (id, issue_id, author_id, body, created_at) values (?, ?, ?, ?, ?)");
  const insertAttachment = client.prepare("insert into attachments (id, issue_id, kind, title, url, created_at) values (?, ?, 'link', ?, ?, ?)");
  const setCounter = client.prepare("update teams set issue_counter = ? where key = ?");

  client.transaction(() => {
    for (const key of teamKeys) {
      const team = allTeams.find((candidate) => candidate.key === key)!;
      const todo = listStates(context, team.id).find((state) => state.name === "Todo")!;
      let previous: string | null = null;
      for (let number = 1; number <= 200; number++) {
        const id = randomUUID();
        insertIssue.run(id, `${key}-${number}`, team.id, number, `Widget task ${number}`, `Fictional widget work item ${number}`,
          todo.id, 1 + (number % 4), actor.id, actor.id, cycleByTeam.get(key), previous, now, now);
        insertLabel.run(id, common.id);
        insertLabel.run(id, secondary.id);
        if (previous) insertDependency.run(previous, id, now);
        if (number % 3 === 0) insertComment.run(randomUUID(), id, actor.id, "A fictional note.", now);
        if (number % 4 === 0) insertAttachment.run(randomUUID(), id, "Spec", "https://example.com/spec", now);
        previous = id;
      }
      setCounter.run(200, key);
    }
  })();
}

interface StatementLogEntry {
  sql: string;
  params: number;
}

// Records every statement execution (SQL text + bind count) on the underlying client.
function spyStatements(db: Db): { log: StatementLogEntry[]; restore: () => void } {
  const client = db.$client;
  const originalPrepare = client.prepare;
  const log: StatementLogEntry[] = [];
  client.prepare = function (this: typeof client, source: string) {
    const statement = originalPrepare.call(this, source) as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ["all", "get", "run", "iterate"]) {
      const original = statement[method]!.bind(statement);
      statement[method] = (...args: unknown[]) => {
        log.push({ sql: source, params: args.flat().length });
        return original(...args);
      };
    }
    return statement as unknown as ReturnType<typeof originalPrepare>;
  } as typeof client.prepare;
  return { log, restore: () => { client.prepare = originalPrepare; } };
}

function initializedContext(now = "2026-01-01T00:00:00.000Z") {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-search-"));
  tempDirs.push(tempDir);
  const db = openDb(join(tempDir, "tracker.db"));
  applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: fixedClock(now) };
  init(context);
  context.actor = whoami(context);
  return { context, db, close: () => db.$client.close() };
}

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}
