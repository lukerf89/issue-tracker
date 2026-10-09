import { afterEach, beforeEach, expect, it } from "vitest";
import {
  applyMigrations,
  createIssue,
  exportSnapshot,
  getIssueProgress,
  init,
  listActivity,
  openDb,
  updateIssueProgress,
  whoami,
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

it("preserves criterion and blocker values in activity history after later edits", () => {
  const issue = createIssue(context, { title: "Validate fictional CI" });
  const added = updateIssueProgress(context, {
    identifier: issue.identifier,
    operations: [
      { type: "criterion", action: "add", text: "Build passes" },
      { type: "blocker", action: "add", kind: "network", description: "Remote unavailable", unblockAction: "Retry publication", owner: "QA" }
    ]
  });
  const criterionId = added.changes[0]!.id;
  const blockerId = added.changes[1]!.id;
  context.clock = { now: () => new Date("2026-01-02T00:00:00Z") };
  const changed = updateIssueProgress(context, {
    identifier: issue.identifier,
    expectedRevision: added.revision,
    operations: [
      { type: "criterion", action: "update", id: criterionId, status: "passed", evidenceUrl: "https://example.test/build" },
      { type: "blocker", action: "update", id: blockerId, owner: "Release", resolved: true }
    ]
  });
  // Mutation responses stay compact even though history retains full values.
  expect(changed.changes).toEqual([{ type: "criterion", id: criterionId }, { type: "blocker", id: blockerId }]);
  context.clock = { now: () => new Date("2026-01-03T00:00:00Z") };
  updateIssueProgress(context, {
    identifier: issue.identifier,
    operations: [
      { type: "criterion", action: "update", id: criterionId, text: "Build needs repair", status: "failed", evidenceUrl: null, archived: true },
      { type: "blocker", action: "update", id: blockerId, resolved: false }
    ]
  });
  const events = listActivity(context, { issue: issue.identifier }).filter((entry) => entry.action === "progress_updated");
  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({
    actorId: context.actor!.id,
    data: { changes: [
      { type: "criterion", action: "add", id: criterionId, before: null, after: { text: "Build passes", status: "pending", evidenceUrl: null } },
      { type: "blocker", action: "add", id: blockerId, before: null, after: { kind: "network", description: "Remote unavailable", unblockAction: "Retry publication", owner: "QA", resolvedAt: null } }
    ] }
  });
  expect(events[1]).toMatchObject({
    createdAt: "2026-01-02T00:00:00.000Z",
    data: { changes: [
      { type: "criterion", action: "update", id: criterionId, before: { status: "pending", evidenceUrl: null }, after: { text: "Build passes", status: "passed", evidenceUrl: "https://example.test/build" } },
      { type: "blocker", action: "update", id: blockerId, before: { owner: "QA", resolvedAt: null }, after: { owner: "Release", resolvedAt: "2026-01-02T00:00:00.000Z" } }
    ] }
  });
  expect(events[2]).toMatchObject({
    data: { changes: [
      { type: "criterion", action: "update", id: criterionId, before: { status: "passed" }, after: { text: "Build needs repair", status: "failed", evidenceUrl: null, archivedAt: "2026-01-03T00:00:00.000Z" } },
      { type: "blocker", action: "update", id: blockerId, before: { resolvedAt: "2026-01-02T00:00:00.000Z" }, after: { resolvedAt: null } }
    ] }
  });
});

it("does not change revisions, timestamps, or history for stale edits and no-ops", () => {
  const issue = createIssue(context, { title: "Check fictional build" });
  const added = updateIssueProgress(context, {
    identifier: issue.identifier,
    operations: [{ type: "criterion", action: "add", text: "Build passes" }]
  });
  const before = exportSnapshot(context);
  context.clock = { now: () => new Date("2026-01-02T00:00:00Z") };
  const operation = { type: "criterion", action: "update", id: added.changes[0]!.id, status: "pending" } as const;
  expect(() => updateIssueProgress(context, {
    identifier: issue.identifier, expectedRevision: issue.revision, operations: [operation]
  })).toThrowError(expect.objectContaining({ code: "ISSUE_CONFLICT" }));
  expect(updateIssueProgress(context, {
    identifier: issue.identifier, expectedRevision: added.revision, operations: [operation]
  })).toEqual({ identifier: issue.identifier, revision: added.revision, changes: [] });
  expect(exportSnapshot(context)).toEqual(before);
});

it("rolls back earlier progress operations when a later record belongs to another issue", () => {
  const first = createIssue(context, { title: "First fictional build" });
  const second = createIssue(context, { title: "Second fictional build" });
  const added = updateIssueProgress(context, {
    identifier: second.identifier,
    operations: [{ type: "criterion", action: "add", text: "Second build passes" }]
  });
  const before = exportSnapshot(context);
  expect(() => updateIssueProgress(context, {
    identifier: first.identifier,
    operations: [
      { type: "criterion", action: "add", text: "First build passes" },
      { type: "criterion", action: "update", id: added.changes[0]!.id, status: "passed" }
    ]
  })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  expect(exportSnapshot(context)).toEqual(before);
});

it("rolls back progress records and revisions when the activity append fails", () => {
  const issue = createIssue(context, { title: "Publish fictional build" });
  const before = exportSnapshot(context);
  db.$client.exec("CREATE TRIGGER reject_progress_activity BEFORE INSERT ON activity WHEN NEW.action = 'progress_updated' BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END");
  expect(() => updateIssueProgress(context, {
    identifier: issue.identifier,
    operations: [{ type: "blocker", action: "add", kind: "human_review", description: "Review pending", unblockAction: "Review build", owner: "QA" }]
  })).toThrow();
  expect(exportSnapshot(context)).toEqual(before);
  expect(getIssueProgress(context, { identifier: issue.identifier })).toMatchObject({ blockers: [], revision: issue.revision });
});
