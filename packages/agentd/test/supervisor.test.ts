import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addRepository, applyMigrations, associateRepository, claimRunAction,
  createIssue, createNodeRepositoryInspector, createProject, exportSnapshot, getRun, init, listRunEvents,
  openDb, previewRun, requestRunPublication, startRun, type Clock, type EngineDefinition, type ServiceContext
} from "@issue-tracker/core";

import { FakeProviderAdapter } from "../src/adapters/fake.js";
import { Supervisor } from "../src/supervisor.js";
import { WorktreeManager } from "../src/worktrees.js";

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("durable coding-run supervisor", () => {
  it("adopts a worktree after lease expiry and completes a verified workflow without duplicate effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-tracker-agentd-")); tempDirs.push(root);
    const db = openDb(join(root, "tracker.db")); applyMigrations(db);
    const clock = mutableClock("2026-07-17T12:00:00.000Z");
    const context: ServiceContext = { db, actor: null, clock };
    try {
      const initialized = init(context, { teamKey: "ENG", actorHandle: "owner" }); context.actor = initialized.actor;
      const project = createProject(context, { name: "Fictional Agent Runtime" });
      const issue = createIssue(context, { title: "Recover a durable worktree", projectId: project.id });
      const repositoryPath = createRepository(root);
      const command = { executable: process.execPath, args: ["-e", "process.exit(0)"], envNames: [] };
      const repository = addRepository(context, { name: "Runtime", path: repositoryPath, testCommand: command, verificationCommand: command }, createNodeRepositoryInspector());
      associateRepository(context, { repository: repository.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
      const runtime = { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data") };
      const preview = previewRun(context, { issue: issue.identifier }, runtime);
      const started = startRun(context, { issue: issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);

      const abandoned = claimRunAction(context, { supervisorId: "crashed-agentd", leaseMs: 1000 })!;
      const spec = (abandoned.payload as { repositories: Array<{ path: string; worktreePath: string; branch: string; baseCommit: string }> }).repositories[0]!;
      const firstEffect = new WorktreeManager(join(root, "data", "worktrees")).provision({ repositoryPath: spec.path, worktreePath: spec.worktreePath, branch: spec.branch, baseCommit: spec.baseCommit });
      expect(firstEffect.adopted).toBe(false);

      clock.advance(2000);
      const fake = new FakeProviderAdapter(["planner", "implementer", "bindingReviewer", "adversarialReviewer"].map((role, index) => ({
        result: { exitCode: 0, sessionId: `fictional-session-${index + 1}`, actualModel: "fictional-model", structuredResult: { role, files: [], tests: [], risks: [] }, events: [{ providerEventId: `${role}-progress`, type: "participant.progress", data: { role }, progress: true }] },
        rawLog: index === 0 ? "private-fictional-prompt-text" : undefined
      })));
      const engine: EngineDefinition = { adapter: "fake", executable: "fixture", model: "fictional-model", permissionMode: "autonomous", envNames: [], capabilities: fake.capabilities };
      const supervisor = new Supervisor({ id: "restarted-agentd", context, dataRoot: join(root, "data"), adapters: { fake }, engines: { "claude-default": engine }, publisher: async () => ({ url: "https://example.test/fictional/pull/42" }) });

      expect(await supervisor.runOnce()).toBe(true);
      expect(getRun(context, started.id)).toMatchObject({ state: "running", phase: "plan" });
      expect(listRunEvents(context, { run: started.id }).events.filter((event) => event.type === "action.completed" && (event.data as { kind?: string }).kind === "provision_worktree")).toHaveLength(1);

      for (let index = 0; index < 6; index += 1) expect(await supervisor.runOnce()).toBe(true);
      const finalized = getRun(context, started.id);
      expect(finalized.phase).toBe("finalize");
      expect(finalized.pendingActions).toHaveLength(0);
      expect(new Set(finalized.participants.filter((participant) => participant.state === "succeeded").map((participant) => participant.providerSessionId)).size).toBe(4);

      requestRunPublication(context, { run: started.id, publishDraftPr: true, confirmed: true });
      expect(await supervisor.runOnce()).toBe(true);
      expect(getRun(context, started.id).pendingActions.map((action) => action.kind)).toEqual(["publish_draft_pr"]);
      expect(await supervisor.runOnce()).toBe(true);
      const result = getRun(context, started.id);
      expect(result).toMatchObject({ phase: "complete", state: "succeeded", outcome: "verified" });
      expect(listRunEvents(context, { run: started.id }).events.at(-1)?.type).toBe("run.succeeded");
      expect(JSON.stringify(exportSnapshot(context))).not.toContain("private-fictional-prompt-text");
      expect(JSON.stringify(exportSnapshot(context, { includeRawLogs: true }))).toContain("private-fictional-prompt-text");
    } finally { db.$client.close(); }
  });
});

function createRepository(root: string) {
  const repository = join(root, "repository");
  execFileSync("git", ["init", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "# Fictional runtime\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fictional User", "-c", "user.email=fictional@example.test", "commit", "-m", "Set up fictional runtime"]);
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["-C", repository, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", repository, "push", "-u", "origin", "main"]);
  return repository;
}

function mutableClock(iso: string): Clock & { advance(milliseconds: number): void } {
  let current = new Date(iso).getTime();
  return { now: () => new Date(current), advance: (milliseconds) => { current += milliseconds; } };
}
