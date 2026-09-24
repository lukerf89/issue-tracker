import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addAttachment,
  addComment,
  AppError,
  AppErrorCode,
  applyMigrations,
  archiveIssue,
  createActor,
  createIssue,
  getIssue,
  init,
  listActivity,
  openDb,
  whoami,
  type AddAttachmentInput,
  type ServiceContext
} from "../src/index.js";
import { attachments, comments } from "../src/db/schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("comment idempotency keys", () => {
  it("replays a keyed comment retry with the stored record and writes nothing", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const first = addComment(f.context, { issue: issue.identifier, body: "Pipeline is green.", idempotencyKey: "c-1" });
      expect(first.alreadyExisted).toBe(false);
      expect(first.createdAt).toBe("2026-01-01T00:00:00.000Z");

      f.advance("2026-01-01T01:00:00.000Z");
      const replay = f.unchanged(issue.identifier, () =>
        addComment(f.context, { issue: issue.identifier, body: "Pipeline is green.", idempotencyKey: "c-1" })
      );
      expect(replay).toMatchObject({ id: first.id, createdAt: first.createdAt, body: first.body, alreadyExisted: true });
      expect(replay.author.id).toBe(f.context.actor!.id);
    } finally { f.close(); }
  });

  it("replays even when the retry carries the original, now-stale expectedRevision", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const first = addComment(f.context, { issue: issue.identifier, body: "Ship it.", expectedRevision: issue.revision, idempotencyKey: "c-stale" });
      expect(getIssue(f.context, issue.identifier).revision).toBe(issue.revision + 1);

      const replay = f.unchanged(issue.identifier, () =>
        addComment(f.context, { issue: issue.identifier, body: "Ship it.", expectedRevision: issue.revision, idempotencyKey: "c-stale" })
      );
      expect(replay).toMatchObject({ id: first.id, alreadyExisted: true });
    } finally { f.close(); }
  });

  it("reports IDEMPOTENCY_KEY_CONFLICT, not ISSUE_CONFLICT, for a conflicting retry with a stale revision", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const first = addComment(f.context, { issue: issue.identifier, body: "Original", expectedRevision: issue.revision, idempotencyKey: " c-conflict " });

      const error = f.unchanged(issue.identifier, () =>
        captureAppError(() => addComment(f.context, { issue: issue.identifier, body: "Changed", expectedRevision: issue.revision, idempotencyKey: "c-conflict" }))
      );
      expect(error.code).toBe(AppErrorCode.IDEMPOTENCY_KEY_CONFLICT);
      expect(error.details).toEqual({
        resource: "comment",
        idempotencyKey: "c-conflict",
        existingId: first.id,
        issueIdentifier: "ENG-1",
        mismatchedFields: ["body"]
      });
    } finally { f.close(); }
  });

  it("treats the issue UUID and identifier as the same canonical issue", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const first = addComment(f.context, { issue: issue.identifier, body: "By identifier", idempotencyKey: "c-uuid" });
      const replay = f.unchanged(issue.identifier, () =>
        addComment(f.context, { issue: issue.id, body: "By identifier", idempotencyKey: "c-uuid" })
      );
      expect(replay).toMatchObject({ id: first.id, alreadyExisted: true });
    } finally { f.close(); }
  });

  it("reports an unresolvable issue ref on a keyed retry as an issueId mismatch, not ISSUE_NOT_FOUND", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      addComment(f.context, { issue: issue.identifier, body: "Hello", idempotencyKey: "c-missing" });
      const error = f.unchanged(issue.identifier, () =>
        captureAppError(() => addComment(f.context, { issue: "ENG-404", body: "Hello", idempotencyKey: "c-missing" }))
      );
      expect(error.code).toBe(AppErrorCode.IDEMPOTENCY_KEY_CONFLICT);
      expect((error.details as { mismatchedFields: string[] }).mismatchedFields).toEqual(["issueId"]);
    } finally { f.close(); }
  });

  it("replays a threaded reply and conflicts on a different parent", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const root = addComment(f.context, { issue: issue.identifier, body: "Root" });
      const other = addComment(f.context, { issue: issue.identifier, body: "Other root" });
      const reply = addComment(f.context, { issue: issue.identifier, body: "Reply", parent: root.id, idempotencyKey: "c-reply" });
      expect(reply.parentId).toBe(root.id);

      const replay = f.unchanged(issue.identifier, () =>
        addComment(f.context, { issue: issue.identifier, body: "Reply", parent: root.id, idempotencyKey: "c-reply" })
      );
      expect(replay).toMatchObject({ id: reply.id, parentId: root.id, alreadyExisted: true });

      for (const parent of [other.id, null]) {
        const error = f.unchanged(issue.identifier, () =>
          captureAppError(() => addComment(f.context, { issue: issue.identifier, body: "Reply", parent, idempotencyKey: "c-reply" }))
        );
        expect((error.details as { mismatchedFields: string[] }).mismatchedFields).toEqual(["parentId"]);
      }
    } finally { f.close(); }
  });

  it("reports each mismatched field, in fixed declared order", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const otherIssue = createIssue(f.context, { title: "Write docs" });
      const root = addComment(f.context, { issue: issue.identifier, body: "Root" });
      addComment(f.context, { issue: issue.identifier, body: "Keyed", idempotencyKey: "c-fields" });
      const otherActor = createActor(f.context, { type: "agent", name: "Other agent", handle: "other-agent" });

      const cases: Array<[ServiceContext, Parameters<typeof addComment>[1], string[]]> = [
        [f.context, { issue: issue.identifier, body: "Different", idempotencyKey: "c-fields" }, ["body"]],
        [f.context, { issue: issue.identifier, body: "Keyed", parent: root.id, idempotencyKey: "c-fields" }, ["parentId"]],
        [f.context, { issue: otherIssue.identifier, body: "Keyed", idempotencyKey: "c-fields" }, ["issueId"]],
        [{ ...f.context, actor: otherActor }, { issue: issue.identifier, body: "Keyed", idempotencyKey: "c-fields" }, ["authorId"]],
        [
          { ...f.context, actor: otherActor },
          { issue: otherIssue.identifier, body: "Different", parent: root.id, idempotencyKey: "c-fields" },
          ["issueId", "authorId", "body", "parentId"]
        ]
      ];
      for (const [context, input, expected] of cases) {
        const error = f.unchanged(issue.identifier, () => captureAppError(() => addComment(context, input)));
        expect(error.code).toBe(AppErrorCode.IDEMPOTENCY_KEY_CONFLICT);
        expect((error.details as { mismatchedFields: string[] }).mismatchedFields).toEqual(expected);
      }
    } finally { f.close(); }
  });

  it("trims keys and treats blank, whitespace, null and absent keys as keyless", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const first = addComment(f.context, { issue: issue.identifier, body: "Trimmed", idempotencyKey: " k " });
      const replay = addComment(f.context, { issue: issue.identifier, body: "Trimmed", idempotencyKey: "k" });
      expect(replay).toMatchObject({ id: first.id, alreadyExisted: true });

      for (const idempotencyKey of ["", "   ", null, undefined]) {
        const a = addComment(f.context, { issue: issue.identifier, body: "Same body", idempotencyKey });
        const b = addComment(f.context, { issue: issue.identifier, body: "Same body", idempotencyKey });
        expect(a.alreadyExisted).toBe(false);
        expect(b.alreadyExisted).toBe(false);
        expect(a.id).not.toBe(b.id);
      }
      const rows = f.context.db.select().from(comments).all();
      expect(rows).toHaveLength(9);
      expect(rows.filter((row) => row.idempotencyKey !== null).map((row) => row.idempotencyKey)).toEqual(["k"]);
    } finally { f.close(); }
  });

  it("keeps distinct keys distinct and comment/attachment keyspaces independent", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const a = addComment(f.context, { issue: issue.identifier, body: "Same", idempotencyKey: "key-a" });
      const b = addComment(f.context, { issue: issue.identifier, body: "Same", idempotencyKey: "key-b" });
      expect(a.id).not.toBe(b.id);
      expect(b.alreadyExisted).toBe(false);
      const link = addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.invalid/a", idempotencyKey: "key-a" });
      expect(link.alreadyExisted).toBe(false);
      expect(f.context.db.select().from(comments).all()).toHaveLength(2);
      expect(f.context.db.select().from(attachments).all()).toHaveLength(1);
    } finally { f.close(); }
  });

  it("replays on an issue archived after the first write", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const first = addComment(f.context, { issue: issue.identifier, body: "Before archive", idempotencyKey: "c-archived" });
      archiveIssue(f.context, issue.identifier);
      const replay = f.unchanged(issue.identifier, () =>
        addComment(f.context, { issue: issue.identifier, body: "Before archive", idempotencyKey: "c-archived" })
      );
      expect(replay).toMatchObject({ id: first.id, alreadyExisted: true });
    } finally { f.close(); }
  });

  it("still bumps the issue revision exactly once per new comment and attachment after migration 0012", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      addComment(f.context, { issue: issue.identifier, body: "One", idempotencyKey: "rev-c" });
      expect(getIssue(f.context, issue.identifier).revision).toBe(issue.revision + 1);
      addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.invalid/r", idempotencyKey: "rev-a" });
      expect(getIssue(f.context, issue.identifier).revision).toBe(issue.revision + 2);
    } finally { f.close(); }
  });
});

describe("attachment idempotency keys", () => {
  const kinds: Array<[string, AddAttachmentInput, Partial<AddAttachmentInput>, string[]]> = [
    ["link", { issue: "ENG-1", kind: "link", url: "https://example.invalid/doc" }, { url: "https://example.invalid/other" }, ["title", "url"]],
    ["branch", { issue: "ENG-1", kind: "branch", repoPath: "/repos/app", branchName: "feature/ci" }, { branchName: "feature/other" }, ["title", "branchName"]],
    ["pr", { issue: "ENG-1", kind: "pr", repoPath: "/repos/app", url: "https://example.invalid/pr/1", title: "PR #1" }, { url: "https://example.invalid/pr/2" }, ["url"]],
    ["commit", { issue: "ENG-1", kind: "commit", repoPath: "/repos/app", commitSha: "abc1234", remote: "origin" }, { remote: "upstream" }, ["remote"]]
  ];

  for (const [kind, input, change, expectedFields] of kinds) {
    it(`replays and conflicts for ${kind} attachments`, () => {
      const f = fixture();
      try {
        const issue = createIssue(f.context, { title: "Set up CI" });
        const first = addAttachment(f.context, { ...input, idempotencyKey: `a-${kind}` });
        expect(first.alreadyExisted).toBe(false);
        f.advance("2026-01-02T00:00:00.000Z");

        const replay = f.unchanged(issue.identifier, () => addAttachment(f.context, { ...input, idempotencyKey: `a-${kind}` }));
        expect(replay).toMatchObject({ id: first.id, createdAt: first.createdAt, alreadyExisted: true });

        const error = f.unchanged(issue.identifier, () =>
          captureAppError(() => addAttachment(f.context, { ...input, ...change, idempotencyKey: `a-${kind}` }))
        );
        expect(error.code).toBe(AppErrorCode.IDEMPOTENCY_KEY_CONFLICT);
        expect(error.details).toEqual({
          resource: "attachment",
          idempotencyKey: `a-${kind}`,
          existingId: first.id,
          issueIdentifier: "ENG-1",
          mismatchedFields: expectedFields
        });
      } finally { f.close(); }
    });
  }

  it("compares the defaulted title, so an explicit title equal to the default replays", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const first = addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.invalid/t", idempotencyKey: "a-title" });
      expect(first.title).toBe("https://example.invalid/t");
      const replay = f.unchanged(issue.identifier, () =>
        addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.invalid/t", title: "https://example.invalid/t", idempotencyKey: "a-title" })
      );
      expect(replay).toMatchObject({ id: first.id, alreadyExisted: true });

      const error = f.unchanged(issue.identifier, () =>
        captureAppError(() => addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.invalid/t", title: "Renamed", idempotencyKey: "a-title" }))
      );
      expect((error.details as { mismatchedFields: string[] }).mismatchedFields).toEqual(["title"]);
    } finally { f.close(); }
  });

  it("reports IDEMPOTENCY_KEY_CONFLICT, not CONSTRAINT_VIOLATION or ISSUE_CONFLICT, for a conflicting keyed retry", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.invalid/x", expectedRevision: issue.revision, idempotencyKey: "a-required" });

      // Missing the kind-required commitSha, and a stale revision: the key match wins.
      const error = f.unchanged(issue.identifier, () =>
        captureAppError(() => addAttachment(f.context, { issue: issue.identifier, kind: "commit", repoPath: "/repos/app", expectedRevision: issue.revision, idempotencyKey: "a-required" }))
      );
      expect(error.code).toBe(AppErrorCode.IDEMPOTENCY_KEY_CONFLICT);
      expect((error.details as { mismatchedFields: string[] }).mismatchedFields).toEqual(["kind", "title", "url", "repoPath"]);

      // A stale-revision replay of the same payload succeeds.
      const replay = f.unchanged(issue.identifier, () =>
        addAttachment(f.context, { issue: issue.id, kind: "link", url: "https://example.invalid/x", expectedRevision: issue.revision, idempotencyKey: "a-required" })
      );
      expect(replay.alreadyExisted).toBe(true);
    } finally { f.close(); }
  });

  it("keeps keyless attachment validation unchanged", () => {
    const f = fixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const error = captureAppError(() => addAttachment(f.context, { issue: issue.identifier, kind: "commit", repoPath: "/repos/app" }));
      expect(error.code).toBe(AppErrorCode.CONSTRAINT_VIOLATION);
      const a = addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.invalid/d", idempotencyKey: "  " });
      const b = addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.invalid/d" });
      expect(a.id).not.toBe(b.id);
      expect([a.alreadyExisted, b.alreadyExisted]).toEqual([false, false]);
    } finally { f.close(); }
  });
});

function fixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-idempotency-"));
  tempDirs.push(tempDir);
  const db = openDb(join(tempDir, "tracker.db"));
  applyMigrations(db);
  let now = "2026-01-01T00:00:00.000Z";
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date(now) } };
  init(context);
  context.actor = whoami(context);

  return {
    context,
    advance(iso: string) { now = iso; },
    /** Runs `work` and asserts issue revision, updatedAt, row counts and activity are unchanged. */
    unchanged<T>(issueId: string, work: () => T): T {
      const snapshot = () => {
        const issue = getIssue(context, issueId);
        return {
          revision: issue.revision,
          updatedAt: issue.updatedAt,
          comments: db.select().from(comments).all().length,
          attachments: db.select().from(attachments).all().length,
          activity: listActivity(context, { issue: issueId })
        };
      };
      const before = snapshot();
      const result = work();
      expect(snapshot()).toEqual(before);
      return result;
    },
    close() { db.$client.close(); }
  };
}

function captureAppError(work: () => unknown): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}
