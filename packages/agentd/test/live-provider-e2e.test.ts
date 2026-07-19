import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { addRepository, applyMigrations, associateRepository, completeRunWorkflow, createIssue, createNodeRepositoryInspector, createProject, getRun, init, listRunEvents, openDb, previewRun, resolveRunPermission, startRun, type EngineDefinition, type ServiceContext } from "@issue-tracker/core";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { providerEnvironment, type ProviderLaunch } from "../src/adapters/contract.js";
import { Supervisor } from "../src/supervisor.js";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("live provider issue-delivery acceptance", () => {
  liveTest("claude-code", "ISSUE_TRACKER_E2E_CLAUDE", new ClaudeCodeAdapter());
  liveTest("codex", "ISSUE_TRACKER_E2E_CODEX", new CodexAdapter());

  const enabled = process.env.ISSUE_TRACKER_E2E_CODEX === "1";
  (enabled ? it : it.skip)("codex preserves the effective sandbox across an initial and resumed turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-tracker-live-codex-sandbox-")); temporaryDirectories.push(root);
    const workingDirectory = createRepository(root);
    const launch: ProviderLaunch = {
      participantId: "fictional-sandbox-participant",
      role: "implementer",
      executable: process.env.ISSUE_TRACKER_E2E_CODEX_EXECUTABLE ?? "codex",
      model: process.env.ISSUE_TRACKER_E2E_CODEX_MODEL ?? "gpt-5.3-codex",
      workingDirectory,
      prompt: `Return only this structured no-op result: ${JSON.stringify({ role: "implementer", summary: "Sandbox acceptance check", files: [], tests: [], risks: [], findings: [], verifiedTestsPassed: true, riskNotes: [] })}`,
      options: { sandbox: "read-only" },
      env: providerEnvironment()
    };
    const adapter = new CodexAdapter();
    const first = await adapter.run(launch);
    expect(first.exitCode, first.rawLog).toBe(0);
    expect(first.failure).toBeNull();
    expect(first.sessionId).toBeTruthy();
    expect(first.structuredResult).toBeTruthy();
    const resumed = await adapter.resume(launch, first.sessionId!);
    expect(resumed.exitCode, resumed.rawLog).toBe(0);
    expect(resumed.failure).toBeNull();
    expect(resumed.structuredResult).toBeTruthy();

    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const rolloutFile = findRolloutFile(join(codexHome, "sessions"), first.sessionId!);
    expect(rolloutFile, `no rollout file found for Codex session ${first.sessionId!}`).toBeTruthy();
    const turnContexts = parseRolloutSandboxModes(rolloutFile!);
    // The requested-versus-effective sandbox contract: both the initial and resumed turn must use
    // the operator's requested sandbox, so a silent resume-time widening cannot pass unnoticed.
    expect(turnContexts.length, "no resumed turn was recorded; the resume assertion would be vacuous").toBeGreaterThanOrEqual(2);
    for (const mode of turnContexts) expect(mode).toBe("read-only");
  }, 20 * 60_000);
});

function liveTest(adapterName: "claude-code" | "codex", flag: string, adapter: ClaudeCodeAdapter | CodexAdapter) {
  const enabled = process.env[flag] === "1";
  (enabled ? it : it.skip)(`${adapterName} completes a fictional isolated workflow`, async () => {
    const root = mkdtempSync(join(tmpdir(), `issue-tracker-live-${adapterName}-`)); temporaryDirectories.push(root);
    const repositoryPath = createRepository(root);
    const dataRoot = join(root, "data");
    const dbPath = join(root, "tracker.db");
    const db = openDb(dbPath); applyMigrations(db);
    const context: ServiceContext = { db, actor: null, clock: { now: () => new Date() } };
    let startedId: string | null = null;
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
      // Autonomous mode is the production shape for both providers. Codex is contained by its own
      // workspace-write sandbox; Claude Code has no OS sandbox and is instead contained by routing
      // every mutating tool call through a durable tracker permission request.
      const engine: EngineDefinition = { adapter: adapterName, executable, model, sandbox: adapterName === "codex" ? "workspace-write" : undefined, permissionMode: "autonomous", envNames, capabilities: adapter.capabilities };
      const engines = { "claude-default": engine };
      const supervisor = new Supervisor({ id: `live-${adapterName}`, context, dataRoot, dbPath, engines, adapters: { [adapterName]: adapter }, permissionTimeoutMs: 2 * 60_000 });
      // Stands in for the human operator so the run is unattended, while still exercising the real
      // durable-approval path rather than bypassing it.
      const approved: string[] = [];
      const operator = setInterval(() => {
        if (!startedId) return;
        for (const request of getRun(context, startedId).inputRequests) {
          if (request.state !== "pending" || request.kind !== "permission") continue;
          resolveRunPermission(context, { run: request.runId, request: request.id, decision: "approved" });
          approved.push(String((request.operation as { summary?: string } | null)?.summary ?? request.prompt));
        }
      }, 250);
      expect(await supervisor.runOnce()).toBe(false); // Probes and persists fresh health without creating a run.
      const runtime = { inspector: createNodeRepositoryInspector(), dataRoot, engineCatalog: { schemaVersion: 1 as const, engines }, executableAvailable: () => true, requireEngineHealth: true };
      const preview = previewRun(context, { issue: issue.identifier }, runtime);
      expect(preview.errors).toEqual([]);
      const started = startRun(context, { issue: issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);
      startedId = started.id;
      try {
        for (let index = 0; index < 40 && getRun(context, started.id).pendingActions.length; index += 1) await supervisor.runOnce();
      } finally { clearInterval(operator); }
      // Claude Code has no kernel-level containment, so the gate is the only thing standing between
      // the model and the filesystem. A run that wrote files without a single adjudicated request
      // means the gate was bypassed, which must fail the acceptance rather than pass quietly.
      if (adapterName === "claude-code") expect(approved.length, "no permission request was adjudicated; the gate was bypassed").toBeGreaterThan(0);
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
      // Scoped to participants that actually held a provider session: roles like orchestrator are
      // bookkeeping rows that never invoke a provider, so they have no model to attribute.
      const attribution = completed.participants.filter((participant) => participant.providerSessionId).map((participant) => ({ role: participant.role, requestedModel: participant.requestedModel, actualModel: participant.actualModel }));
      expect(attribution.length, "no participant held a provider session; the attribution check would be vacuous").toBeGreaterThan(0);
      for (const participant of attribution) {
        expect(participant.requestedModel).toBe(model);
        expect(participant.actualModel, `participant ${participant.role} reported no actual model`).toBeTruthy();
      }
      process.stdout.write(`${JSON.stringify({ provider: adapterName, runState: completed.state, participants: completed.participants.length, filesChanged: result.filesChanged, attribution, permissionsApproved: approved, rawLogs: "redacted" })}\n`);
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

function findRolloutFile(directory: string, sessionId: string): string | null {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findRolloutFile(path, sessionId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) return path;
  }
  return null;
}

function parseRolloutSandboxModes(path: string): Array<string | null> {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    const record = JSON.parse(line) as { type?: unknown; sandbox_policy?: unknown; payload?: { sandbox_policy?: unknown } };
    if (record.type !== "turn_context") return [];
    const policy = record.sandbox_policy ?? record.payload?.sandbox_policy;
    const rawMode = typeof policy === "string" ? policy : policy && typeof policy === "object" ? (policy as { mode?: unknown; type?: unknown }).mode ?? (policy as { type?: unknown }).type : null;
    return [typeof rawMode === "string" ? rawMode.replaceAll("_", "-") : null];
  });
}
