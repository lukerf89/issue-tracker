import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { addRepository, applyMigrations, associateRepository, completeRunWorkflow, createIssue, createNodeRepositoryInspector, createProject, getRun, init, listRunEvents, openDb, previewRun, startRun, type EngineDefinition, type ServiceContext } from "@issue-tracker/core";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { Supervisor } from "../src/supervisor.js";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("live provider issue-delivery acceptance", () => {
  liveTest("claude-code", "ISSUE_TRACKER_E2E_CLAUDE", new ClaudeCodeAdapter());
  liveTest("codex", "ISSUE_TRACKER_E2E_CODEX", new CodexAdapter());
});

function liveTest(adapterName: "claude-code" | "codex", flag: string, adapter: ClaudeCodeAdapter | CodexAdapter) {
  const enabled = process.env[flag] === "1";
  (enabled ? it : it.skip)(`${adapterName} completes a fictional isolated workflow`, async () => {
    const root = mkdtempSync(join(tmpdir(), `issue-tracker-live-${adapterName}-`)); temporaryDirectories.push(root);
    const repositoryPath = createRepository(root);
    const dataRoot = join(root, "data");
    const db = openDb(join(root, "tracker.db")); applyMigrations(db);
    const context: ServiceContext = { db, actor: null, clock: { now: () => new Date() } };
    try {
      const initialized = init(context, { teamKey: "ENG", actorHandle: "fictional-owner" }); context.actor = initialized.actor;
      const project = createProject(context, { name: "Fictional Provider Acceptance" });
      const issue = createIssue(context, { title: "Add the fictional greeting", description: "Add GREETING.md containing exactly `Hello from the fictional acceptance run.` Commit the change before reporting completion. Do not publish or push.", projectId: project.id });
      const command = { executable: process.execPath, args: ["-e", "const fs=require('fs');if(fs.readFileSync('GREETING.md','utf8').trim()!=='Hello from the fictional acceptance run.')process.exit(1)"], envNames: [] };
      const repository = addRepository(context, { name: "Fictional", path: repositoryPath, testCommand: command, verificationCommand: command }, createNodeRepositoryInspector());
      associateRepository(context, { repository: repository.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
      const executable = process.env[`${flag}_EXECUTABLE`] ?? (adapterName === "codex" ? "codex" : "claude");
      const model = process.env[`${flag}_MODEL`] ?? (adapterName === "codex" ? "gpt-5.3-codex" : "claude-sonnet-4-5");
      const envNames = (process.env[`${flag}_ENV_NAMES`] ?? "HOME,PATH").split(",").filter(Boolean);
      const engine: EngineDefinition = { adapter: adapterName, executable, model, sandbox: adapterName === "codex" ? "workspace-write" : undefined, permissionMode: "prompt", envNames, capabilities: adapter.capabilities };
      const engines = { "claude-default": engine };
      const supervisor = new Supervisor({ id: `live-${adapterName}`, context, dataRoot, engines, adapters: { [adapterName]: adapter } });
      expect(await supervisor.runOnce()).toBe(false); // Probes and persists fresh health without creating a run.
      const runtime = { inspector: createNodeRepositoryInspector(), dataRoot, engineCatalog: { schemaVersion: 1 as const, engines }, executableAvailable: () => true, requireEngineHealth: true };
      const preview = previewRun(context, { issue: issue.identifier }, runtime);
      expect(preview.errors).toEqual([]);
      const started = startRun(context, { issue: issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);
      for (let index = 0; index < 20 && getRun(context, started.id).pendingActions.length; index += 1) expect(await supervisor.runOnce()).toBe(true);
      const finalized = getRun(context, started.id);
      const finalize = finalized.pendingActions.length === 0 ? db.query.runActions.findMany().sync().find((action) => action.runId === started.id && action.kind === "finalize") : null;
      expect(finalize?.state).toBe("completed");
      const result = finalize!.result as { commitSha: string; filesChanged: string[]; diffSize: number; branch: string };
      completeRunWorkflow(context, { run: started.id, commitSha: result.commitSha, filesChanged: result.filesChanged, diffSize: result.diffSize, testsRun: ["test", "verification"], testsFailed: [], riskNotes: [], branch: result.branch });
      const completed = getRun(context, started.id);
      expect(completed).toMatchObject({ state: "succeeded", phase: "complete" });
      expect(result.commitSha).not.toBe(completed.baseCommit);
      expect(result.filesChanged).toContain("GREETING.md");
      expect(listRunEvents(context, { run: started.id }).events.map((event) => event.sequence)).toEqual(listRunEvents(context, { run: started.id }).events.map((_, index) => index + 1));
      for (const artifact of completed.artifacts.filter((candidate) => candidate.kind === "raw_log" && candidate.localPath)) expect(statSync(artifact.localPath!).mode & 0o077).toBe(0);
      // The requested-versus-actual audit contract: every participant that ran must report which
      // model actually served it, so a silent provider-side substitution cannot pass unnoticed.
      const attribution = completed.participants.map((participant) => ({ role: participant.role, requestedModel: participant.requestedModel, actualModel: participant.actualModel }));
      for (const participant of attribution) {
        expect(participant.requestedModel).toBe(model);
        expect(participant.actualModel, `participant ${participant.role} reported no actual model`).toBeTruthy();
      }
      process.stdout.write(`${JSON.stringify({ provider: adapterName, runState: completed.state, participants: completed.participants.length, filesChanged: result.filesChanged, attribution, rawLogs: "redacted" })}\n`);
    } finally { db.$client.close(); }
  }, 20 * 60_000);
}

function createRepository(root: string) {
  const repository = join(root, "repository");
  execFileSync("git", ["init", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "# Fictional acceptance repository\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fictional User", "-c", "user.email=fictional@example.test", "commit", "-m", "Set up fictional acceptance repository"]);
  return repository;
}
