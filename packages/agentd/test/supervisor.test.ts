import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addRepository, applyMigrations, associateRepository, claimRunAction,
  completeRunWorkflow, createIssue, createNodeRepositoryInspector, createProject, exportSnapshot, getRun, init, listRunEvents,
  addComment, getWorkContext, openDb, previewRun, requestRunPublication, startRun, updateIssue, workContextForPrompt,
  type Clock, type EngineDefinition, type ServiceContext
} from "@issue-tracker/core";

import { FakeProviderAdapter } from "../src/adapters/fake.js";
import { Supervisor } from "../src/supervisor.js";
import { WorktreeManager } from "../src/worktrees.js";

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("durable coding-run supervisor", () => {
  it("refuses to adopt a same-named worktree that moved from the immutable base commit", () => {
    const root = mkdtempSync(join(tmpdir(), "issue-tracker-agentd-adopt-")); tempDirs.push(root);
    const repositoryPath = createRepository(root);
    const manager = new WorktreeManager(join(root, "data", "worktrees"));
    const baseCommit = execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const worktreePath = join(root, "data", "worktrees", "fictional-run", "repository");
    const spec = { repositoryPath, worktreePath, branch: "agent/fictional-run", baseCommit };
    manager.provision(spec);
    writeFileSync(join(worktreePath, "CHANGE.md"), "fictional change\n");
    execFileSync("git", ["-C", worktreePath, "add", "CHANGE.md"]);
    execFileSync("git", ["-C", worktreePath, "-c", "user.name=Fictional User", "-c", "user.email=fictional@example.test", "commit", "-m", "Move managed branch"]);
    expect(() => manager.provision(spec)).toThrowError(/immutable base commit/);
  });

  it("rejects a managed-root symlink that resolves to an external repository", () => {
    const root = mkdtempSync(join(tmpdir(), "issue-tracker-agentd-symlink-")); tempDirs.push(root);
    const repositoryPath = createRepository(root);
    const managedRoot = join(root, "data", "worktrees");
    mkdirSync(managedRoot, { recursive: true });
    const worktreePath = join(managedRoot, "fictional-run");
    symlinkSync(repositoryPath, worktreePath, "dir");
    const manager = new WorktreeManager(managedRoot);
    const baseCommit = execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(() => manager.provision({ repositoryPath, worktreePath, branch: "main", baseCommit })).toThrowError(/resolves outside/);
  });

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
      const secondaryPath = createRepository(root, "secondary");
      const secondary = addRepository(context, { name: "Secondary", path: secondaryPath, testCommand: command, verificationCommand: command }, createNodeRepositoryInspector());
      associateRepository(context, { repository: secondary.id, project: project.id, position: 1, isDefault: false, overrideKind: "replace" });
      const capabilities = { resume: true, redirect: true, interactivePermissions: true, structuredOutput: true, childParticipants: false, usage: true };
      const engine: EngineDefinition = { adapter: "fake", executable: "fixture", model: "fictional-model", permissionMode: "autonomous", envNames: [], capabilities };
      const runtime = { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data"), engineCatalog: { schemaVersion: 1 as const, engines: { "claude-default": engine } } };
      const preview = previewRun(context, { issue: issue.identifier }, runtime);
      const started = startRun(context, { issue: issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);

      const abandoned = claimRunAction(context, { supervisorId: "crashed-agentd", leaseMs: 1000 })!;
      const spec = (abandoned.payload as { repositories: Array<{ path: string; worktreePath: string; branch: string; baseCommit: string }> }).repositories[0]!;
      const firstEffect = new WorktreeManager(join(root, "data", "worktrees")).provision({ repositoryPath: spec.path, worktreePath: spec.worktreePath, branch: spec.branch, baseCommit: spec.baseCommit });
      expect(firstEffect.adopted).toBe(false);

      clock.advance(2000);
      const fake = new FakeProviderAdapter([0, 1, 2, 3].map((index) => ({
        result: (launch: { role: string }) => { const role = launch.role; return { exitCode: 0, sessionId: `fictional-session-${index + 1}`, actualModel: "fictional-model", structuredResult: { role, summary: `${role} completed fictional work`, files: [], tests: [], risks: [], findings: [], verifiedTestsPassed: true, riskNotes: [], ...(role === "planner" ? { risk: "low" as const, estimatedSize: "small" } : {}) }, events: [{ providerEventId: `${role}-progress`, type: "participant.progress", data: { role }, progress: true }] }; },
        rawLog: index === 0 ? "private-fictional-prompt-text" : undefined
      })));
      const supervisor = new Supervisor({ id: "restarted-agentd", context, dataRoot: join(root, "data"), adapters: { fake }, engines: { "claude-default": engine }, publisher: async () => ({ url: "https://example.test/fictional/pull/42" }) });

      expect(await supervisor.runOnce()).toBe(true);
      expect(getRun(context, started.id)).toMatchObject({ state: "running", phase: "plan" });
      expect(listRunEvents(context, { run: started.id }).events.filter((event) => event.type === "action.completed" && (event.data as { kind?: string }).kind === "provision_worktree")).toHaveLength(1);

      for (let index = 0; index < 6; index += 1) {
        const worked = await supervisor.runOnce();
        const observed = getRun(context, started.id);
        expect(worked, `iteration ${index}: ${observed.phase}/${observed.state}; pending=${observed.pendingActions.map((action) => action.kind).join(",")}`).toBe(true);
      }
      const finalized = getRun(context, started.id);
      expect(finalized.phase).toBe("finalize");
      expect(finalized.pendingActions).toHaveLength(0);
      expect(new Set(finalized.participants.filter((participant) => participant.state === "succeeded").map((participant) => participant.providerSessionId)).size).toBe(4);
      const finalizeAction = (exportSnapshot(context).runActions as Array<{ id: string; kind: string; result: { repositoryId: string; commitSha: string; filesChanged: string[]; diffSize: number; branch: string; repositories?: Array<{ repositoryId: string; commitSha: string }> } | null }>).find((action) => action.kind === "finalize")!;
      const finalizeResult = finalizeAction.result!;
      expect(finalizeResult.repositories).toHaveLength(2);
      const staleResult = { ...finalizeResult, repositories: finalizeResult.repositories!.map((repository, index) => index === 1 ? { ...repository, commitSha: "stale-secondary-commit" } : repository) };
      db.$client.prepare("update run_actions set result = ? where id = ?").run(JSON.stringify(staleResult), finalizeAction.id);
      expect(() => completeRunWorkflow(context, { run: started.id, commitSha: finalizeResult.commitSha, filesChanged: finalizeResult.filesChanged, diffSize: finalizeResult.diffSize, testsRun: ["test", "verification", "test", "verification"], testsFailed: [], riskNotes: [], branch: finalizeResult.branch })).toThrowError(/finalized commits/);
      db.$client.prepare("update run_actions set result = ? where id = ?").run(JSON.stringify(finalizeResult), finalizeAction.id);

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
  }, 120_000);

  it("feeds participants the frozen work context verbatim, identical to the snapshot and live reads", async () => {
    const { context, run, prompt, liveAtLaunch, close } = await launchFirstParticipant();
    try {
      const workContext = (prompt as { workContext: unknown }).workContext;
      expect(workContext).toStrictEqual(workContextForPrompt(getRun(context, run.id).resolvedConfiguration));
      expect(workContext).toStrictEqual(getWorkContext(context, { identifier: "ENG-1", run: run.id }).context);
      // The explicit live read of the same source state (taken at launch, before the run mutated anything).
      expect(workContext).toStrictEqual(liveAtLaunch);
      expect((workContext as { sections: { acceptanceCriteria: { items: string[] } } }).sections.acceptanceCriteria.items).toEqual(["Worktree is recovered", "No duplicate effects"]);
    } finally { close(); }
  }, 120_000);

  it("launches legacy runs without a work-context snapshot with workContext null", async () => {
    const { prompt, close } = await launchFirstParticipant({ legacy: true });
    try {
      expect(prompt).toHaveProperty("workContext", null);
      expect(prompt).toHaveProperty("issue.identifier", "ENG-1");
    } finally { close(); }
  }, 120_000);
});

async function launchFirstParticipant(options: { legacy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "issue-tracker-agentd-context-")); tempDirs.push(root);
  const db = openDb(join(root, "tracker.db")); applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: mutableClock("2026-07-17T12:00:00.000Z") };
  context.actor = init(context, { teamKey: "ENG", actorHandle: "owner" }).actor;
  const project = createProject(context, { name: "Fictional Agent Runtime" });
  const issue = createIssue(context, { title: "Recover a durable worktree", projectId: project.id, description: "Recovery work.\n\n## Done when\n- Worktree is recovered\n- No duplicate effects\n" });
  createIssue(context, { title: "Fictional prerequisite" });
  updateIssue(context, issue.identifier, { blockedBy: ["ENG-2"] });
  addComment(context, { issue: issue.identifier, body: "Decision: recover in place" });
  const command = { executable: process.execPath, args: ["-e", "process.exit(0)"], envNames: [] };
  const repository = addRepository(context, { name: "Runtime", path: createRepository(root), testCommand: command, verificationCommand: command }, createNodeRepositoryInspector());
  associateRepository(context, { repository: repository.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
  const capabilities = { resume: true, redirect: true, interactivePermissions: true, structuredOutput: true, childParticipants: false, usage: true };
  const engine: EngineDefinition = { adapter: "fake", executable: "fixture", model: "fictional-model", permissionMode: "autonomous", envNames: [], capabilities };
  const runtime = { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data"), engineCatalog: { schemaVersion: 1 as const, engines: { "claude-default": engine } } };
  const preview = previewRun(context, { issue: issue.identifier }, runtime);
  const run = startRun(context, { issue: issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);
  const liveAtLaunch = getWorkContext(context, { identifier: issue.identifier }).context;
  if (options.legacy) {
    const legacy = { ...(run.resolvedConfiguration as Record<string, unknown>) };
    delete legacy.workContext;
    db.$client.prepare("update agent_runs set resolved_configuration = ? where id = ?").run(JSON.stringify(legacy), run.id);
  }
  const fake = new FakeProviderAdapter([{ result: (launch: { role: string }) => ({ exitCode: 0, sessionId: "fictional-session", actualModel: "fictional-model", structuredResult: { role: launch.role, summary: "Planned fictional work", files: [], tests: [], risks: [], findings: [], verifiedTestsPassed: true, riskNotes: [], risk: "low" as const, estimatedSize: "small" }, events: [] }) }]);
  const supervisor = new Supervisor({ id: "context-agentd", context, dataRoot: join(root, "data"), adapters: { fake }, engines: { "claude-default": engine } });
  for (let index = 0; index < 4 && fake.launches.length === 0; index += 1) await supervisor.runOnce();
  const launched = fake.launches[0];
  if (!launched) throw new Error("expected a participant launch");
  const prompt = JSON.parse(launched.prompt.slice(launched.prompt.indexOf("\n") + 1)) as Record<string, unknown>;
  return { context, run, prompt, liveAtLaunch, close: () => db.$client.close() };
}

function createRepository(root: string, name = "repository") {
  const repository = join(root, name);
  execFileSync("git", ["init", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "# Fictional runtime\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fictional User", "-c", "user.email=fictional@example.test", "commit", "-m", "Set up fictional runtime"]);
  const remote = join(root, `${name}-remote.git`);
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["-C", repository, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", repository, "push", "-u", "origin", "main"]);
  return repository;
}

function mutableClock(iso: string): Clock & { advance(milliseconds: number): void } {
  let current = new Date(iso).getTime();
  return { now: () => new Date(current), advance: (milliseconds) => { current += milliseconds; } };
}
