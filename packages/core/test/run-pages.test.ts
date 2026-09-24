import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  AppError, addRepository, applyMigrations, archiveRun, associateRepository, createIssue, createNodeRepositoryInspector, createProject,
  getRun, getRunSummary, init, listRunRecords, listRunSummaries, listRuns, openDb, previewRun, requestRunStop, respondToRunInput,
  runResponse, startRun, type Clock, type RunRecordCollection, type RunSummary, type ServiceContext
} from "../src/index.js";
import {
  agentRuns, repositories, runActions, runArtifacts, runAttempts, runInputRequests, runParticipants, runRepositories, runReviewFindings, runVerifications
} from "../src/db/schema.js";

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const SUMMARY_KEYS = ["id", "issue", "profileId", "workflow", "state", "phase", "outcome", "errorCode", "branch", "parallelGroup", "attemptCount", "eventCount", "pending", "createdAt", "updatedAt", "startedAt", "lastEventAt", "lastProgressAt", "completedAt", "archivedAt"];
const COLLECTIONS: RunRecordCollection[] = ["repositories", "attempts", "participants", "artifacts", "inputRequests", "verifications", "reviewFindings", "pendingActions"];

describe("run summary pages", () => {
  it("returns bounded compact pages with fixed keys, explicit nulls and pending counts", () => {
    const fixture = setup();
    try {
      const page = listRunSummaries(fixture.context, { limit: 10 });
      expect(page.runs).toHaveLength(10);
      expect(page.nextCursor).toMatch(/^rn1\./);
      for (const summary of page.runs) {
        expect(Object.keys(summary)).toEqual(SUMMARY_KEYS);
        expect(summary).not.toHaveProperty("resolvedConfiguration");
        expect(summary).not.toHaveProperty("worktreePath");
        expect(summary).not.toHaveProperty("artifacts");
      }
      const live = page.runs[0]!;
      expect(live).toEqual({
        id: fixture.run.id, issue: { id: fixture.issue.id, identifier: fixture.issue.identifier }, profileId: fixture.run.profileId, workflow: fixture.run.workflow,
        state: "queued", phase: fixture.run.phase, outcome: null, errorCode: null, branch: fixture.run.branch, parallelGroup: null,
        attemptCount: fixture.run.attemptCounter, eventCount: fixture.run.eventCounter,
        pending: { actions: getRun(fixture.context, fixture.run.id).pendingActions.length, inputRequests: 1, permissionRequests: 1 },
        createdAt: fixture.run.createdAt, updatedAt: fixture.run.updatedAt, startedAt: null, lastEventAt: fixture.run.lastEventAt, lastProgressAt: fixture.run.lastProgressAt,
        completedAt: null, archivedAt: null
      });
      expect(live.pending.actions).toBeGreaterThan(1);
      const failed = page.runs.find((summary) => summary.state === "failed")!;
      expect(failed).toMatchObject({ errorCode: "fictional_failure", outcome: "failed", completedAt: expect.any(String) });
      // A summary page is a small fraction of the hydrated equivalent.
      const hydrated = listRuns(fixture.context).slice(0, 10);
      expect(JSON.stringify(page.runs).length * 4).toBeLessThan(JSON.stringify(hydrated).length);
    } finally { fixture.close(); }
  });

  it("walks every matching run exactly once in listRuns order for each filter", () => {
    const fixture = setup();
    try {
      for (const filters of [{}, { issue: fixture.otherIssue.identifier }, { state: "failed" as const }, { includeArchived: true }, { issue: fixture.issue.identifier, includeArchived: true }]) {
        for (const limit of [1, 7, 25, 100]) {
          if (limit === 1 && Object.keys(filters).length !== 1) continue;
          const walked = walk(fixture.context, filters, limit);
          expect(walked.map((summary) => summary.id), JSON.stringify({ filters, limit })).toEqual(listRuns(fixture.context, filters).map((run) => run.id));
          expect(new Set(walked.map((summary) => summary.id)).size).toBe(walked.length);
        }
      }
      expect(walk(fixture.context, {}, 25).length).toBeLessThan(walk(fixture.context, { includeArchived: true }, 25).length);
      expect(walk(fixture.context, { state: "queued" }, 5).map((summary) => summary.id)).toEqual([fixture.run.id]);
    } finally { fixture.close(); }
  });

  it("uses live keyset semantics when runs are archived or created mid-traversal", () => {
    const fixture = setup();
    try {
      const expected = listRuns(fixture.context).map((run) => run.id);
      const first = listRunSummaries(fixture.context, { limit: 10 });
      const seen = first.runs.map((summary) => summary.id);
      const unseenTarget = expected[40]!;
      const seenTarget = seen[5]!;
      archiveRun(fixture.context, unseenTarget);
      archiveRun(fixture.context, seenTarget);
      // A newer run sorts ahead of the cursor and is not revisited by this traversal.
      fixture.context.clock = fixedClock("2026-07-18T12:00:00.000Z");
      const newer = insertTerminalRun(fixture, fixture.otherIssue.id, "2026-07-18T12:00:00.000Z", 999);
      const rest: string[] = [];
      let cursor = first.nextCursor;
      while (cursor) { const page = listRunSummaries(fixture.context, { cursor, limit: 10 }); rest.push(...page.runs.map((summary) => summary.id)); cursor = page.nextCursor; }
      const all = [...seen, ...rest];
      expect(new Set(all).size).toBe(all.length);
      expect(all).toEqual(expected.filter((id) => id !== unseenTarget));
      expect(all).not.toContain(newer);
      expect(listRunSummaries(fixture.context, { limit: 1 }).runs[0]!.id).toBe(newer);
    } finally { fixture.close(); }
  });

  it("rejects malformed, overlong, mistyped and incompatible cursors and unknown runs", () => {
    const fixture = setup();
    try {
      const filtered = listRunSummaries(fixture.context, { state: "failed", limit: 2 }).nextCursor!;
      expectCode(() => listRunSummaries(fixture.context, { cursor: filtered, limit: 2 }), "VALIDATION_FAILED");
      expectCode(() => listRunSummaries(fixture.context, { state: "failed", includeArchived: true, cursor: filtered, limit: 2 }), "VALIDATION_FAILED");
      expect(listRunSummaries(fixture.context, { state: "failed", cursor: filtered, limit: 2 }).runs).toHaveLength(2);
      for (const cursor of ["garbage", "it1.abc", "rn1.", "rn1.!!!", "rn1." + "A".repeat(5000), encode({ version: 1, kind: "runs", query: "x", key: [1, randomUUID()] }), encode({ version: 2, kind: "runs", query: "x", key: ["2026-07-17T12:00:00.000Z", randomUUID()] })]) {
        expectCode(() => listRunSummaries(fixture.context, { cursor, limit: 2 }), "VALIDATION_FAILED");
      }
      const artifactCursor = listRunRecords(fixture.context, { run: fixture.run.id, collection: "artifacts", limit: 2 }).nextCursor!;
      expectCode(() => listRunRecords(fixture.context, { run: fixture.run.id, collection: "reviewFindings", cursor: artifactCursor, limit: 2 }), "VALIDATION_FAILED");
      expectCode(() => listRunRecords(fixture.context, { run: fixture.seededRunIds[0]!, collection: "artifacts", cursor: artifactCursor, limit: 2 }), "VALIDATION_FAILED");
      expectCode(() => listRunSummaries(fixture.context, { cursor: artifactCursor, limit: 2 }), "VALIDATION_FAILED");
      expectCode(() => listRunRecords(fixture.context, { run: fixture.run.id, collection: "artifacts", cursor: encode({ version: 1, kind: "records", run: fixture.run.id, collection: "artifacts", key: [3, randomUUID()] }), limit: 2 }), "VALIDATION_FAILED");
      expectCode(() => listRunRecords(fixture.context, { run: fixture.run.id, collection: "attempts", cursor: encode({ version: 1, kind: "records", run: fixture.run.id, collection: "attempts", key: [0, randomUUID()] }), limit: 2 }), "VALIDATION_FAILED");
      expectCode(() => listRunRecords(fixture.context, { run: randomUUID(), collection: "artifacts" }), "RUN_NOT_FOUND");
      expectCode(() => getRunSummary(fixture.context, randomUUID()), "RUN_NOT_FOUND");
    } finally { fixture.close(); }
  });

  it("issues a fixed number of statements regardless of page size and never reads configuration", () => {
    const fixture = setup();
    try {
      const statements = (work: () => unknown) => {
        const client = fixture.db.$client; const original = client.prepare.bind(client); const sql: string[] = [];
        client.prepare = ((source: string) => { sql.push(source); return original(source); }) as typeof client.prepare;
        try { work(); } finally { client.prepare = original as typeof client.prepare; }
        return sql;
      };
      const small = statements(() => listRunSummaries(fixture.context, { limit: 5, includeArchived: true }));
      const large = statements(() => listRunSummaries(fixture.context, { limit: 50, includeArchived: true }));
      expect(large.length).toBe(small.length);
      expect(small.length).toBeGreaterThan(0);
      expect(small.length).toBeLessThanOrEqual(4);
      const single = statements(() => getRunSummary(fixture.context, fixture.run.id));
      for (const source of [...small, ...large, ...single]) expect(source).not.toContain("resolved_configuration");
      // Record pages check existence cheaply rather than hydrating the run.
      for (const source of statements(() => listRunRecords(fixture.context, { run: fixture.run.id, collection: "artifacts", limit: 5 }))) expect(source).not.toContain("resolved_configuration");
    } finally { fixture.close(); }
  });
});

describe("run record pages", () => {
  it("pages every collection in exactly the hydrated order at every page boundary", () => {
    const fixture = setup();
    try {
      const full = getRun(fixture.context, fixture.run.id) as unknown as Record<RunRecordCollection, unknown[]>;
      for (const collection of COLLECTIONS) {
        const expected = full[collection];
        expect(expected.length, collection).toBeGreaterThan(1);
        for (const limit of [1, 7, expected.length, 100]) {
          const pages = walkRecords(fixture.context, fixture.run.id, collection, limit);
          expect(pages.every((page) => page.items.length <= limit)).toBe(true);
          expect(pages.at(-1)!.nextCursor).toBeNull();
          expect(pages.flatMap((page) => page.items), `${collection} limit ${limit}`).toEqual(expected);
        }
      }
      expect(full.artifacts.length).toBeGreaterThan(100);
      const firstPage = listRunRecords(fixture.context, { run: fixture.run.id, collection: "artifacts" });
      expect(firstPage).toMatchObject({ run: fixture.run.id, collection: "artifacts" });
      expect(firstPage.items).toHaveLength(25);
    } finally { fixture.close(); }
  });

  it("treats pendingActions as a live view without duplicates", () => {
    const fixture = setup();
    try {
      const expected = getRun(fixture.context, fixture.run.id).pendingActions.map((action) => action.id);
      const first = listRunRecords(fixture.context, { run: fixture.run.id, collection: "pendingActions", limit: 2 });
      const completed = expected[3]!;
      fixture.db.update(runActions).set({ state: "completed", completedAt: "2026-07-17T12:00:00.000Z" }).where(eq(runActions.id, completed)).run();
      const rest: string[] = [];
      let cursor = first.nextCursor;
      while (cursor) { const page = listRunRecords(fixture.context, { run: fixture.run.id, collection: "pendingActions", cursor, limit: 2 }); rest.push(...page.items.map((item) => item.id as string)); cursor = page.nextCursor; }
      expect([...first.items.map((item) => item.id), ...rest]).toEqual(expected.filter((id) => id !== completed));
    } finally { fixture.close(); }
  });
});

describe("run views", () => {
  it("keeps getRun hydrated and offers compact post-mutation responses", () => {
    const fixture = setup();
    try {
      const full = getRun(fixture.context, fixture.run.id);
      expect(full.resolvedConfiguration).toBeTypeOf("object");
      expect(full.artifacts.length).toBeGreaterThan(100);
      const summary = getRunSummary(fixture.context, fixture.run.id);
      expect(Object.keys(summary)).toEqual(SUMMARY_KEYS);

      const before = summary.pending.actions;
      const stopped = runResponse(fixture.context, requestRunStop(fixture.context, fixture.run.id), "summary") as RunSummary;
      expect(Object.keys(stopped)).toEqual(SUMMARY_KEYS);
      expect(stopped.pending.actions).toBe(before + 1);
      expect(stopped.eventCount).toBe(summary.eventCount + 1);
      expect(runResponse(fixture.context, requestRunStop(fixture.context, fixture.run.id), "full")).toHaveProperty("resolvedConfiguration");

      fixture.context.clock = fixedClock("2026-07-17T13:00:00.000Z");
      const archived = runResponse(fixture.context, archiveRun(fixture.context, fixture.seededRunIds[0]!), "summary") as RunSummary;
      expect(archived).toMatchObject({ id: fixture.seededRunIds[0], archivedAt: "2026-07-17T13:00:00.000Z", state: "failed" });
      expect(archived).not.toHaveProperty("resolvedConfiguration");

      const request = full.inputRequests.find((item) => item.kind === "input" && item.state === "pending")!;
      fixture.db.update(runParticipants).set({ state: "waiting", providerSessionId: "fictional-session" }).where(eq(runParticipants.id, request.participantId)).run();
      expect(respondToRunInput(fixture.context, { run: fixture.run.id, request: request.id, response: "Use the fictional default." })).toMatchObject({ id: request.id, state: "answered" });
    } finally { fixture.close(); }
  });
});

function walk(context: ServiceContext, filters: { issue?: string; state?: "failed" | "queued"; includeArchived?: boolean }, limit: number) {
  const out: RunSummary[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = listRunSummaries(context, { ...filters, cursor, limit });
    expect(page.runs.length).toBeLessThanOrEqual(limit);
    out.push(...page.runs);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

function walkRecords(context: ServiceContext, run: string, collection: RunRecordCollection, limit: number) {
  const pages = [];
  let cursor: string | undefined;
  for (;;) {
    const page = listRunRecords(context, { run, collection, cursor, limit });
    pages.push(page);
    if (!page.nextCursor) return pages;
    cursor = page.nextCursor;
  }
}

function encode(value: unknown) { return "rn1." + Buffer.from(JSON.stringify(value)).toString("base64url"); }

function expectCode(work: () => unknown, code: string) {
  let caught: unknown;
  try { work(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

function insertTerminalRun(fixture: { context: ServiceContext; repositoryId: string; configuration: unknown }, issueId: string, createdAt: string, index: number) {
  const id = randomUUID();
  fixture.context.db.insert(agentRuns).values({
    id, issueId, profileId: null, workflow: "fictional-flow", workflowVersion: 1, schemaVersion: 1, resolvedConfiguration: fixture.configuration,
    phase: "implement", state: "failed", primaryRepositoryId: fixture.repositoryId, baseRef: "main", baseCommit: "0".repeat(40), branch: `fictional/run-${index}`,
    worktreePath: `/fictional/worktrees/run-${index}`, parallelGroup: null, eventCounter: 3, attemptCounter: 1, startedAt: createdAt, lastEventAt: createdAt,
    lastProgressAt: createdAt, completedAt: createdAt, outcome: "failed", error: { code: "fictional_failure", message: "Fictional failure." }, archivedAt: null, createdAt, updatedAt: createdAt
  }).run();
  return id;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "issue-tracker-run-pages-")); tempDirs.push(root);
  const db = openDb(join(root, "tracker.db")); applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: fixedClock("2026-07-17T12:00:00.000Z") };
  const initialized = init(context, { teamKey: "ENG", actorHandle: "owner" }); context.actor = initialized.actor;
  const project = createProject(context, { name: "Fictional Delivery" });
  const issue = createIssue(context, { title: "Set up CI", projectId: project.id });
  const otherIssue = createIssue(context, { title: "Write fictional docs", projectId: project.id });
  const repository = join(root, "repo"); execFileSync("git", ["init", "-q", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "# Fictional repository\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fictional User", "-c", "user.email=fictional@example.test", "commit", "-q", "-m", "Set up fictional repository"]);
  const registered = addRepository(context, { name: "Primary", path: repository, testCommand: { executable: "node", args: ["--test"], envNames: [] }, verificationCommand: { executable: "npm", args: ["run", "typecheck"], envNames: [] } }, createNodeRepositoryInspector());
  associateRepository(context, { repository: registered.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
  const runtime = { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data") };
  const preview = previewRun(context, { issue: issue.identifier }, runtime);
  const run = startRun(context, { issue: issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);

  // About 120 fictional terminal runs across two issues; groups of three share createdAt to exercise the id tiebreak.
  const base = { context, repositoryId: registered.id, configuration: run.resolvedConfiguration };
  const seededRunIds: string[] = [];
  for (let index = 0; index < 120; index += 1) {
    const createdAt = new Date(Date.parse("2026-07-01T00:00:00.000Z") + Math.floor(index / 3) * 60_000).toISOString();
    const id = insertTerminalRun(base, index % 2 === 0 ? issue.id : otherIssue.id, createdAt, index);
    if (index % 10 === 9) db.update(agentRuns).set({ archivedAt: createdAt }).where(eq(agentRuns.id, id)).run();
    seededRunIds.push(id);
  }

  // Large related collections on the live run; shared timestamps exercise the id tiebreak.
  const attempt = run.attempts[0]!;
  const participant = run.participants[0]!;
  const stamp = (index: number, group = 4) => new Date(Date.parse("2026-07-17T12:00:00.000Z") + Math.floor(index / group) * 1000).toISOString();
  for (let index = 0; index < 150; index += 1) {
    db.insert(runArtifacts).values({ id: randomUUID(), runId: run.id, attemptId: attempt.id, kind: "log", title: `Fictional artifact ${index}`, localPath: null, url: null, sha256: null, metadata: { index }, attachmentId: null, removedAt: index % 17 === 0 ? stamp(index) : null, createdAt: stamp(index) }).run();
  }
  for (let number = 2; number <= 9; number += 1) {
    db.insert(runAttempts).values({ id: randomUUID(), runId: run.id, number, reason: "retry", requestedEngine: { engine: null }, actualEngine: null, state: "failed", startedAt: stamp(number), completedAt: stamp(number), result: null, error: { reason: "retry" }, createdAt: stamp(number) }).run();
  }
  for (let index = 0; index < 12; index += 1) {
    db.insert(runParticipants).values({ id: randomUUID(), runId: run.id, attemptId: attempt.id, actor: `fictional-${index}`, role: index % 2 === 0 ? "implementer" : "verifier", adapter: "fictional", requestedModel: "fictional-model", actualModel: null, providerSessionId: null, capabilities: {}, processIdentity: null, state: "queued", startedAt: null, lastHeartbeatAt: null, completedAt: null }).run();
  }
  for (let index = 0; index < 4; index += 1) {
    const repositoryId = randomUUID();
    db.insert(repositories).values({ id: repositoryId, name: `Fictional ${index}`, canonicalPath: `/fictional/repositories/${index}`, commonDir: `/fictional/repositories/${index}/.git`, defaultBranch: "main", remote: null, setupCommand: null, testCommand: { executable: "node", args: [], envNames: [] }, verificationCommand: { executable: "node", args: [], envNames: [] }, archivedAt: null, createdAt: stamp(0), updatedAt: stamp(0) }).run();
    db.insert(runRepositories).values({ runId: run.id, repositoryId, position: index % 2, baseRef: "main", baseCommit: "0".repeat(40), worktreePath: `/fictional/worktrees/live-${index}`, branch: `fictional/live-${index}`, isPrimary: false }).run();
  }
  const kinds = ["input", "permission", "input", "input", "permission", "input"] as const;
  kinds.forEach((kind, index) => {
    db.insert(runInputRequests).values({ id: randomUUID(), runId: run.id, participantId: participant.id, kind, prompt: `Fictional prompt ${index}`, operation: null, blocking: true, delivery: "resume", state: index < 2 ? "pending" : "answered", response: index < 2 ? null : "ok", requestedBy: participant.id, respondedBy: null, requestedAt: stamp(index, 3), respondedAt: null }).run();
  });
  for (let index = 0; index < 9; index += 1) {
    db.insert(runVerifications).values({ id: randomUUID(), runId: run.id, attemptId: attempt.id, commitSha: "0".repeat(40), command: { executable: "npm", args: ["test"] }, startedAt: stamp(index, 3), completedAt: stamp(index, 3), exitCode: 0, classification: "clean", logArtifactId: null, summary: { index } }).run();
    db.insert(runReviewFindings).values({ id: randomUUID(), runId: run.id, participantId: participant.id, fingerprint: `fictional-${index}`, severity: "info", source: "binding", file: null, location: null, summary: `Fictional finding ${index}`, evidence: "Fictional evidence.", resolution: null, reconciliation: null, createdAt: stamp(index, 3) }).run();
    db.insert(runActions).values({ id: randomUUID(), runId: run.id, attemptId: attempt.id, kind: "fictional_action", idempotencyKey: `fictional-${index}`, payload: {}, state: "queued", leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: stamp(index, 3), updatedAt: stamp(index, 3), completedAt: index === 8 ? stamp(index, 3) : null }).run();
  }
  return { root, db, context, issue, otherIssue, repositoryId: registered.id, configuration: run.resolvedConfiguration, run: getRun(context, run.id), seededRunIds, close: () => db.$client.close() };
}

function fixedClock(iso: string): Clock { return { now: () => new Date(iso) }; }
