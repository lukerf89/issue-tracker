import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  addRepository, addRepositoryInputSchema, applyMigrations, assertContained, associateRepository, claimRunAction, completeRunAction,
  createIssue, createNodeRepositoryInspector, createProject, errorEnvelope, exportSnapshot,
  failRun, getProfile, getRun, importSnapshot, init, listRunEvents, listRuns, openDb, previewRun,
  markRunStalled, recordProcessExit, requestRunInput, respondToRunInput, retryRun, startRun, startRunParticipant,
  type Clock, type ServiceContext
} from "../src/index.js";
import { runParticipants } from "../src/db/schema.js";

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("autonomous coding run control plane", () => {
  it("canonicalizes repository identity and resolves issue overrides deterministically", () => {
    const fixture = setup();
    try {
      const alias = join(fixture.root, "repo-alias");
      symlinkSync(fixture.repository, alias);
      expect(() => addRepository(fixture.context, repositoryInput("Alias", alias), createNodeRepositoryInspector())).toThrowError(/already represents/);

      const secondPath = createGitRepository(fixture.root, "second-repo");
      const second = addRepository(fixture.context, repositoryInput("Second", secondPath), createNodeRepositoryInspector());
      associateRepository(fixture.context, { repository: second.id, issue: fixture.issue.identifier, position: 0, isDefault: false, overrideKind: "replace" });
      const preview = previewRun(fixture.context, { issue: fixture.issue.identifier }, fixture.runtime);
      expect(preview.repositories.map((repository) => repository.name)).toEqual(["Second"]);
    } finally { fixture.close(); }
  });

  it("previews without mutation and starts the complete durable graph atomically", () => {
    const fixture = setup();
    try {
      const before = exportSnapshot(fixture.context);
      const preview = previewRun(fixture.context, { issue: fixture.issue.identifier }, fixture.runtime);
      expect(exportSnapshot(fixture.context)).toEqual(before);

      const run = startRun(fixture.context, { issue: fixture.issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, fixture.runtime);
      expect(run.state).toBe("queued");
      expect(run.attempts).toHaveLength(1);
      expect(run.participants.map((participant) => participant.role)).toEqual(["adversarialReviewer", "bindingReviewer", "implementer", "orchestrator", "planner", "verifier"]);
      expect(run.pendingActions).toHaveLength(1);
      expect(listRunEvents(fixture.context, { run: run.id })).toMatchObject({ events: [{ sequence: 1, type: "run.created" }], nextCursor: 1 });

      expect(() => startRun(fixture.context, { issue: fixture.issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, fixture.runtime)).toThrow();
      const parallelPreview = previewRun(fixture.context, { issue: fixture.issue.identifier, parallelGroup: "manual-2" }, fixture.runtime);
      const parallel = startRun(fixture.context, { issue: fixture.issue.identifier, parallelGroup: "manual-2", previewFingerprint: parallelPreview.previewFingerprint, confirmWarnings: parallelPreview.warnings }, fixture.runtime);
      expect(parallel.worktreePath).not.toBe(run.worktreePath);
      expect(listRuns(fixture.context, { issue: fixture.issue.identifier })).toHaveLength(2);
    } finally { fixture.close(); }
  });

  it("leases each durable action once and makes completion idempotent", () => {
    const fixture = setup();
    try {
      const preview = previewRun(fixture.context, { issue: fixture.issue.identifier }, fixture.runtime);
      const run = startRun(fixture.context, { issue: fixture.issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, fixture.runtime);
      const action = claimRunAction(fixture.context, { supervisorId: "agentd-a" });
      expect(action?.runId).toBe(run.id);
      expect(claimRunAction(fixture.context, { supervisorId: "agentd-b" })).toBeNull();
      completeRunAction(fixture.context, { actionId: action!.id, supervisorId: "agentd-a", result: { adopted: false } });
      const eventCount = listRunEvents(fixture.context, { run: run.id }).events.length;
      completeRunAction(fixture.context, { actionId: action!.id, supervisorId: "agentd-a", result: { adopted: false } });
      expect(listRunEvents(fixture.context, { run: run.id }).events).toHaveLength(eventCount);
      expect(getRun(fixture.context, run.id)).toMatchObject({ state: "running", phase: "plan" });
      expect(getRun(fixture.context, run.id).pendingActions.map((pending) => pending.kind)).toEqual(["run_participant"]);
    } finally { fixture.close(); }
  });

  it("rejects illegal terminal recovery and safely targets exact participant sessions", () => {
    const fixture = setup();
    try {
      const preview = previewRun(fixture.context, { issue: fixture.issue.identifier }, fixture.runtime);
      const started = startRun(fixture.context, { issue: fixture.issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, fixture.runtime);
      const action = claimRunAction(fixture.context, { supervisorId: "agentd" })!;
      completeRunAction(fixture.context, { actionId: action.id, supervisorId: "agentd", result: {} });
      const run = getRun(fixture.context, started.id);
      const planner = run.participants.find((participant) => participant.role === "planner")!;
      fixture.db.update(runParticipants).set({ state: "running", providerSessionId: "session-fictional", startedAt: fixture.context.clock.now().toISOString() }).where(eq(runParticipants.id, planner.id)).run();
      const request = requestRunInput(fixture.context, { run: run.id, participantId: planner.id, kind: "input", prompt: "Choose a fictional module." });
      const answered = respondToRunInput(fixture.context, { run: run.id, request: request.id, response: "Use the queue module." });
      expect(respondToRunInput(fixture.context, { run: run.id, request: request.id, response: "Use the queue module." })).toEqual(answered);
      expect(getRun(fixture.context, run.id).state).toBe("running");

      const terminal = failRun(fixture.context, run.id, "failed", { reason: "fictional_failure" }, "fictional_failure");
      expect(terminal.completedAt).not.toBeNull();
      expect(() => failRun(fixture.context, run.id, "failed", { reason: "again" }, "again")).toThrowError(/Terminal runs/);
    } finally { fixture.close(); }
  });

  it("round-trips structured history and returns standard envelopes for invalid JSON", () => {
    const fixture = setup();
    const target = emptyContext();
    try {
      const preview = previewRun(fixture.context, { issue: fixture.issue.identifier }, fixture.runtime);
      const run = startRun(fixture.context, { issue: fixture.issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, fixture.runtime);
      const snapshot = exportSnapshot(fixture.context);
      expect(JSON.stringify(snapshot)).not.toContain("Choose a fictional module");
      importSnapshot(target.context, snapshot);
      expect(getRun(target.context, run.id)).toEqual(getRun(fixture.context, run.id));
      expect(errorEnvelope(addRepositoryInputError())).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
      fixture.db.$client.prepare("update orchestration_profiles set configuration = ? where name = ?").run("[]", "issue-delivery");
      expect(errorEnvelope(captureError(() => getProfile(fixture.context, "issue-delivery")))).toMatchObject({ error: { code: "DATA_INTEGRITY" } });
    } finally { fixture.close(); target.close(); }
  });

  it("distinguishes stalls, retries, and clean exits without structured results", () => {
    const fixture = setup();
    try {
      const preview = previewRun(fixture.context, { issue: fixture.issue.identifier }, fixture.runtime);
      const started = startRun(fixture.context, { issue: fixture.issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, fixture.runtime);
      const provision = claimRunAction(fixture.context, { supervisorId: "agentd" })!;
      completeRunAction(fixture.context, { actionId: provision.id, supervisorId: "agentd", result: {} });
      expect(markRunStalled(fixture.context, started.id).state).toBe("stalled");
      const retried = retryRun(fixture.context, { run: started.id, engine: "fictional-fallback", reason: "fallback" });
      expect(retried.attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
      const implementer = startRunParticipant(fixture.context, { run: started.id, attemptId: retried.attempts[1]!.id, role: "implementer", actor: "fictional-fallback", adapter: "fake", requestedModel: "fictional-model", capabilities: {} });
      fixture.db.update(runParticipants).set({ state: "running", providerSessionId: "clean-exit-no-result" }).where(eq(runParticipants.id, implementer.id)).run();
      expect(recordProcessExit(fixture.context, { run: started.id, participantId: implementer.id, exitCode: 0, structuredResult: null })).toMatchObject({ state: "failed", outcome: "missing_structured_result" });
      expect(() => assertContained(join(fixture.root, "data", "worktrees"), fixture.root)).toThrowError(/outside/);
    } finally { fixture.close(); }
  });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "issue-tracker-runs-")); tempDirs.push(root);
  const db = openDb(join(root, "tracker.db")); applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: fixedClock("2026-07-17T12:00:00.000Z") };
  const initialized = init(context, { teamKey: "ENG", actorHandle: "owner" }); context.actor = initialized.actor;
  const project = createProject(context, { name: "Fictional Delivery" });
  const issue = createIssue(context, { title: "Build durable fictional runs", projectId: project.id });
  const repository = createGitRepository(root, "repo");
  const registered = addRepository(context, repositoryInput("Primary", repository), createNodeRepositoryInspector());
  associateRepository(context, { repository: registered.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
  return { root, db, context, issue, repository, runtime: { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data") }, close: () => db.$client.close() };
}

function emptyContext() {
  const root = mkdtempSync(join(tmpdir(), "issue-tracker-import-runs-")); tempDirs.push(root);
  const db = openDb(join(root, "tracker.db")); applyMigrations(db);
  return { context: { db, actor: null, clock: fixedClock("2026-07-17T12:00:00.000Z") } satisfies ServiceContext, close: () => db.$client.close() };
}

function createGitRepository(root: string, name: string) {
  const repository = join(root, name); execFileSync("git", ["init", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "# Fictional repository\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fictional User", "-c", "user.email=fictional@example.test", "commit", "-m", "Set up fictional repository"]);
  return repository;
}

function repositoryInput(name: string, path: string) {
  return { name, path, testCommand: { executable: "node", args: ["--test"], envNames: [] }, verificationCommand: { executable: "npm", args: ["run", "typecheck"], envNames: [] } };
}

function fixedClock(iso: string): Clock { return { now: () => new Date(iso) }; }
function addRepositoryInputError() { try { addRepositoryInputSchema.parse({ name: "Broken" }); throw new Error("expected validation failure"); } catch (error) { return error; } }
function captureError(work: () => unknown) { try { work(); throw new Error("expected failure"); } catch (error) { return error; } }
