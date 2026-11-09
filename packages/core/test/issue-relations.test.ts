import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AppError,
  AppErrorCode,
  applyMigrations,
  archiveIssue,
  buildWorkContext,
  createIssue,
  createTeam,
  exportSnapshot,
  getIssue,
  getIssueProgress,
  getIssueResponse,
  getIssuesResponse,
  importSnapshot,
  init,
  listActivity,
  listIssues,
  listIssuesPage,
  moveIssue,
  openDb,
  searchIssues,
  serializeIssue,
  updateIssue,
  whoami,
  workContextSchema,
  type Db,
  type ServiceContext
} from "../src/index.js";

let db: Db;
let context: ServiceContext;
beforeEach(() => {
  db = openDb(":memory:");
  applyMigrations(db);
  context = { db, actor: null, clock: { now: () => new Date("2026-01-01T00:00:00Z") } };
  init(context);
  context.actor = whoami(context);
});
afterEach(() => db.$client.close());

const ids = (refs: Array<{ identifier: string }>) => refs.map((ref) => ref.identifier);

function expectAppError(work: () => unknown, code: string) {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error("expected failure");
}

describe("related links (symmetric)", () => {
  it("is visible from both issues and can be added from either side", () => {
    createIssue(context, { title: "Set up CI" });
    createIssue(context, { title: "Cache dependencies" });
    createIssue(context, { title: "Flaky test triage", related: ["ENG-1"] });
    updateIssue(context, "ENG-2", { related: ["ENG-1"] });

    expect(ids(getIssue(context, "ENG-1").related)).toEqual(["ENG-2", "ENG-3"]);
    expect(ids(getIssue(context, "ENG-2").related)).toEqual(["ENG-1"]);
    expect(ids(getIssue(context, "ENG-3").related)).toEqual(["ENG-1"]);
    expect(getIssue(context, "ENG-1").followUps).toEqual([]);
    expect(getIssue(context, "ENG-1").followUpOf).toEqual([]);
  });

  it("is idempotent: re-adding from either side writes no extra activity or revision", () => {
    createIssue(context, { title: "Set up CI" });
    createIssue(context, { title: "Cache dependencies" });
    updateIssue(context, "ENG-1", { related: ["ENG-2"] });
    const revision = getIssue(context, "ENG-1").revision;
    const activityCount = listActivity(context, { issue: "ENG-1" }).length;

    updateIssue(context, "ENG-1", { related: ["ENG-2"] });
    updateIssue(context, "ENG-2", { related: ["ENG-1"] });

    expect(getIssue(context, "ENG-1").revision).toBe(revision);
    expect(listActivity(context, { issue: "ENG-1" })).toHaveLength(activityCount);
    expect(ids(getIssue(context, "ENG-1").related)).toEqual(["ENG-2"]);
  });

  it("removes from either side, and removing a missing link is a no-op", () => {
    createIssue(context, { title: "Set up CI" });
    createIssue(context, { title: "Cache dependencies" });
    createIssue(context, { title: "Flaky test triage" });
    updateIssue(context, "ENG-1", { related: ["ENG-2", "ENG-3"] });

    updateIssue(context, "ENG-2", { removeRelated: ["ENG-1"] });
    expect(ids(getIssue(context, "ENG-1").related)).toEqual(["ENG-3"]);
    expect(getIssue(context, "ENG-2").related).toEqual([]);

    const before = getIssue(context, "ENG-2").revision;
    updateIssue(context, "ENG-2", { removeRelated: ["ENG-1"] });
    expect(getIssue(context, "ENG-2").revision).toBe(before);
  });

  it("rejects self links and add+remove of the same issue in one update", () => {
    createIssue(context, { title: "Set up CI" });
    createIssue(context, { title: "Cache dependencies" });

    expectAppError(() => updateIssue(context, "ENG-1", { related: ["ENG-1"] }), AppErrorCode.CONSTRAINT_VIOLATION);
    expectAppError(() => updateIssue(context, "ENG-1", { followUpOf: ["ENG-1"] }), AppErrorCode.CONSTRAINT_VIOLATION);
    expectAppError(
      () => updateIssue(context, "ENG-1", { related: ["ENG-2"], removeRelated: ["ENG-2"] }),
      AppErrorCode.CONSTRAINT_VIOLATION
    );
    expectAppError(
      () => updateIssue(context, "ENG-1", { followUpOf: ["ENG-2"], removeFollowUpOf: ["ENG-2"] }),
      AppErrorCode.CONSTRAINT_VIOLATION
    );
    expect(getIssue(context, "ENG-1").related).toEqual([]);
  });
});

describe("follow-up links (directional)", () => {
  it("links a follow-up to a Done issue without changing progress, blockers, or ready status", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Tidy release notes" });
    createIssue(context, { title: "Blocking dependency" });
    createIssue(context, { title: "Gated work", blockedBy: ["ENG-3"] });
    moveIssue(context, "ENG-1", "Done");

    const progressBefore = getIssueProgress(context, { identifier: "ENG-1" });
    const gatedBefore = getIssueProgress(context, { identifier: "ENG-4" });
    const readyBefore = ids(listIssues(context, { ready: true }));

    updateIssue(context, "ENG-2", { followUpOf: ["ENG-1"] });
    updateIssue(context, "ENG-4", { related: ["ENG-1"] });

    const progressAfter = getIssueProgress(context, { identifier: "ENG-1" });
    expect(progressAfter).toMatchObject({
      unresolvedBlockers: progressBefore.unresolvedBlockers,
      childCount: progressBefore.childCount,
      remainingCriteria: progressBefore.remainingCriteria,
      statusCounts: progressBefore.statusCounts,
      dependencyBlockers: progressBefore.dependencyBlockers,
      criteria: progressBefore.criteria,
      blockers: progressBefore.blockers,
      children: progressBefore.children
    });
    expect(progressAfter.followUps).toEqual([{ identifier: "ENG-2", state: "Todo", archived: false }]);
    expect(progressAfter.related).toEqual([{ identifier: "ENG-4", state: "Todo", archived: false }]);
    expect(progressAfter.followUpOf).toEqual([]);

    const followUp = getIssueProgress(context, { identifier: "ENG-2" });
    expect(followUp.followUpOf).toEqual([{ identifier: "ENG-1", state: "Done", archived: false }]);
    expect(followUp.unresolvedBlockers).toBe(0);

    const gatedAfter = getIssueProgress(context, { identifier: "ENG-4" });
    expect(gatedAfter.unresolvedBlockers).toBe(gatedBefore.unresolvedBlockers);
    expect(gatedAfter.dependencyBlockers).toEqual(["ENG-3"]);
    expect(ids(listIssues(context, { ready: true }))).toEqual(readyBefore);
  });

  it("is visible from both ends, ordered deterministically", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Follow-up B" });
    createIssue(context, { title: "Follow-up A" });
    updateIssue(context, "ENG-3", { followUpOf: ["ENG-1"] });
    updateIssue(context, "ENG-2", { followUpOf: ["ENG-1"] });

    expect(ids(getIssue(context, "ENG-1").followUps)).toEqual(["ENG-2", "ENG-3"]);
    expect(ids(getIssue(context, "ENG-2").followUpOf)).toEqual(["ENG-1"]);
    expect(getIssue(context, "ENG-1").followUpOf).toEqual([]);
    expect(getIssue(context, "ENG-2").followUps).toEqual([]);
  });

  it("accepts followUpOf and related on create and removes follow-up links", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Follow-up", followUpOf: ["ENG-1"], related: ["ENG-1"] });
    expect(ids(getIssue(context, "ENG-2").followUpOf)).toEqual(["ENG-1"]);
    expect(ids(getIssue(context, "ENG-2").related)).toEqual(["ENG-1"]);

    updateIssue(context, "ENG-2", { removeFollowUpOf: ["ENG-1"] });
    expect(getIssue(context, "ENG-2").followUpOf).toEqual([]);
    expect(getIssue(context, "ENG-1").followUps).toEqual([]);
    expect(ids(getIssue(context, "ENG-2").related)).toEqual(["ENG-1"]);
  });

  it("keeps the link readable when an endpoint is archived", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Follow-up" });
    updateIssue(context, "ENG-2", { followUpOf: ["ENG-1"] });
    archiveIssue(context, "ENG-1");

    expect(ids(getIssue(context, "ENG-2").followUpOf)).toEqual(["ENG-1"]);
    expect(ids(getIssue(context, "ENG-1").followUps)).toEqual(["ENG-2"]);
    expect(getIssueProgress(context, { identifier: "ENG-2" }).followUpOf).toEqual([
      { identifier: "ENG-1", state: "Todo", archived: true }
    ]);
    expect(ids(listIssues(context, { followUpOf: "ENG-1", includeArchived: true }))).toEqual(["ENG-2"]);
  });
});

describe("cross-team links, activity and revisions", () => {
  it("links across teams", () => {
    createTeam(context, { key: "OPS", name: "Operations" });
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Ops follow-up", team: "OPS", followUpOf: ["ENG-1"], related: ["ENG-1"] });

    expect(ids(getIssue(context, "ENG-1").followUps)).toEqual(["OPS-1"]);
    expect(ids(getIssue(context, "ENG-1").related)).toEqual(["OPS-1"]);
    expect(ids(listIssues(context, { related: "ENG-1" }))).toEqual(["OPS-1"]);
  });

  it("records add and remove on both issues in one transaction and bumps both revisions", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Follow-up" });
    const before = [getIssue(context, "ENG-1").revision, getIssue(context, "ENG-2").revision];

    updateIssue(context, "ENG-2", { followUpOf: ["ENG-1"] });
    expect(getIssue(context, "ENG-1").revision).toBeGreaterThan(before[0]!);
    expect(getIssue(context, "ENG-2").revision).toBeGreaterThan(before[1]!);

    const data = { kind: "follow_up", sourceIdentifier: "ENG-1", targetIdentifier: "ENG-2" };
    for (const issue of ["ENG-1", "ENG-2"]) {
      expect(listActivity(context, { issue }).filter((entry) => entry.action === "relation_added")).toHaveLength(1);
      expect(listActivity(context, { issue }).find((entry) => entry.action === "relation_added")!.data).toMatchObject(data);
    }

    updateIssue(context, "ENG-2", { removeFollowUpOf: ["ENG-1"] });
    for (const issue of ["ENG-1", "ENG-2"]) {
      expect(listActivity(context, { issue }).filter((entry) => entry.action === "relation_removed")).toHaveLength(1);
    }
  });

  it("honours expectedRevision when linking", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Follow-up" });
    const stale = getIssue(context, "ENG-2").revision;
    updateIssue(context, "ENG-1", { related: ["ENG-2"] });

    expectAppError(
      () => updateIssue(context, "ENG-2", { expectedRevision: stale, related: ["ENG-1"] }),
      AppErrorCode.ISSUE_CONFLICT
    );
  });
});

describe("reads and filters", () => {
  beforeEach(() => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Release follow-up one" });
    createIssue(context, { title: "Release related note" });
    createIssue(context, { title: "Unlinked release item" });
    updateIssue(context, "ENG-2", { followUpOf: ["ENG-1"] });
    updateIssue(context, "ENG-3", { related: ["ENG-1"] });
  });

  it("filters list and search by related and followUpOf", () => {
    expect(ids(listIssues(context, { related: "ENG-1" }))).toEqual(["ENG-3"]);
    expect(ids(listIssues(context, { related: "ENG-3" }))).toEqual(["ENG-1"]);
    expect(ids(listIssues(context, { followUpOf: "ENG-1" }))).toEqual(["ENG-2"]);
    expect(listIssues(context, { followUpOf: "ENG-2" })).toEqual([]);
    expect(ids(searchIssues(context, { query: "release", related: "ENG-1" }))).toEqual(["ENG-3"]);
    expect(ids(searchIssues(context, { query: "release", followUpOf: "ENG-1" }))).toEqual(["ENG-2"]);
    expectAppError(() => listIssues(context, { related: "ENG-99" }), AppErrorCode.ISSUE_NOT_FOUND);
  });

  it("projects the relation fields on pages and bounded reads", () => {
    const page = listIssuesPage(context, {}, { fields: ["related", "followUpOf", "followUps"] });
    const byId = new Map(page.rows.map((row) => [(row.issue as { identifier: string }).identifier, row.issue as unknown as Record<string, Array<{ identifier: string }>>]));
    expect(ids(byId.get("ENG-1")!.related!)).toEqual(["ENG-3"]);
    expect(ids(byId.get("ENG-1")!.followUps!)).toEqual(["ENG-2"]);
    expect(ids(byId.get("ENG-2")!.followUpOf!)).toEqual(["ENG-1"]);
    expect(byId.get("ENG-4")!.related).toEqual([]);
    expect(serializeIssue(page.rows[0]!.issue as never)).toHaveProperty("related");

    const single = getIssueResponse(context, { identifier: "ENG-1", fields: ["related", "followUps"] }) as { data: Record<string, unknown> };
    expect(Object.keys(single.data).sort()).toEqual(["followUps", "related"]);
    const many = getIssuesResponse(context, { identifiers: ["ENG-2", "ENG-3"], fields: ["followUpOf", "related"] }) as { issues: Array<{ data: Record<string, Array<{ identifier: string }>> }> };
    expect(ids(many.issues[0]!.data.followUpOf!)).toEqual(["ENG-1"]);
    expect(ids(many.issues[1]!.data.related!)).toEqual(["ENG-1"]);
  });
});

describe("work context", () => {
  it("omits the relations section for issues without links and includes it for linked ones", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Follow-up" });
    const plain = buildWorkContext(context, "ENG-1", 16384);
    expect(plain.sections).not.toHaveProperty("relations");

    updateIssue(context, "ENG-2", { followUpOf: ["ENG-1"] });
    updateIssue(context, "ENG-2", { related: ["ENG-1"] });
    const linked = buildWorkContext(context, "ENG-1", 16384);
    expect(workContextSchema.parse(linked).sections.relations).toMatchObject({
      total: 2,
      truncated: false,
      items: [
        { relation: "related", identifier: "ENG-2", state: { name: "Todo", type: "unstarted" }, archived: false },
        { relation: "followUp", identifier: "ENG-2", state: { name: "Todo", type: "unstarted" }, archived: false }
      ]
    });
    expect(linked.omissions).toEqual([]);
  });

  it("cuts relation items to fit the budget and reports an omission with a retrieval path", () => {
    createIssue(context, { title: "Ship fictional release", description: "x".repeat(2000) });
    for (let index = 0; index < 60; index += 1) {
      createIssue(context, { title: `Follow-up number ${index} with a reasonably long fictional title`, followUpOf: ["ENG-1"] });
    }
    const bounded = buildWorkContext(context, "ENG-1", 4096);
    const relations = bounded.sections.relations!;
    expect(relations.total).toBe(60);
    expect(relations.items.length).toBeLessThan(60);
    expect(relations.truncated).toBe(true);
    expect(bounded.omissions.find((omission) => omission.section === "relations")).toMatchObject({
      reason: "budget",
      unit: "items",
      retrieval: { mcp: { tool: "get_issue", args: { identifier: "ENG-1", fields: ["related", "followUpOf", "followUps"] } } }
    });
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(4096);
  });

  it("still parses contexts persisted before the relations section existed", () => {
    createIssue(context, { title: "Ship fictional release" });
    const stored = buildWorkContext(context, "ENG-1", 16384);
    expect(workContextSchema.safeParse(JSON.parse(JSON.stringify(stored))).success).toBe(true);
  });
});

describe("export, import and migration", () => {
  it("round-trips relations and still imports snapshots that predate them", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Follow-up", followUpOf: ["ENG-1"], related: ["ENG-1"] });
    const snapshot = exportSnapshot(context);
    expect(snapshot.issueRelations.map((row) => row.kind)).toEqual(["follow_up", "related"]);

    const destination = openDb(":memory:");
    try {
      applyMigrations(destination);
      const target: ServiceContext = { db: destination, actor: null, clock: context.clock };
      expect(importSnapshot(target, snapshot).issueRelations).toBe(2);
      expect(exportSnapshot(target).issueRelations).toEqual(snapshot.issueRelations);
      expect(ids(getIssue(target, "ENG-1").followUps)).toEqual(["ENG-2"]);
    } finally {
      destination.$client.close();
    }

    const legacy = { ...snapshot } as Record<string, unknown>;
    delete legacy.issueRelations;
    const legacyDb = openDb(":memory:");
    try {
      applyMigrations(legacyDb);
      const target: ServiceContext = { db: legacyDb, actor: null, clock: context.clock };
      expect(importSnapshot(target, legacy).issueRelations).toBe(0);
    } finally {
      legacyDb.$client.close();
    }
  });

  it("rejects malformed relation rows in a snapshot", () => {
    createIssue(context, { title: "Ship fictional release" });
    createIssue(context, { title: "Follow-up", related: ["ENG-1"] });
    const snapshot = exportSnapshot(context);
    const [row] = snapshot.issueRelations;

    for (const bad of [
      { ...row!, targetIssueId: row!.sourceIssueId },
      { ...row!, sourceIssueId: row!.targetIssueId, targetIssueId: row!.sourceIssueId }
    ]) {
      const destination = openDb(":memory:");
      try {
        applyMigrations(destination);
        const target: ServiceContext = { db: destination, actor: null, clock: context.clock };
        expect(() => importSnapshot(target, { ...snapshot, issueRelations: [bad] })).toThrow();
        expect(exportSnapshot(target).issues).toEqual([]);
      } finally {
        destination.$client.close();
      }
    }
  });
});
