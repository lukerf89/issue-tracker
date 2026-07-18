import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertContained, claimRunAction, completeRunAction, confirmRunStopped, failRunAction, getRun, heartbeatRunAction, heartbeatRunParticipant, heartbeatSupervisor, listRuns, markRunStalled, recordArtifact,
  recordParticipantProcess, recordProcessExit, recordProviderEvent, recordReviewFinding, recordVerification, registerSupervisor, releaseExpiredRunActions, resolveReviewFindings, startRunParticipant,
  type EngineDefinition, type ServiceContext
} from "@issue-tracker/core";

import { sha256File, writePrivateLog } from "./artifacts.js";
import { executeCommand } from "./commands.js";
import type { ProviderAdapter, ProviderResult } from "./adapters/contract.js";
import { WorktreeManager } from "./worktrees.js";
import { publishDraftPullRequest } from "./publishers/github-cli.js";

export interface SupervisorOptions {
  id: string;
  context: ServiceContext;
  dataRoot: string;
  adapters: Record<string, ProviderAdapter>;
  engines: Record<string, EngineDefinition>;
  pollMs?: number;
  leaseMs?: number;
  globalLimit?: number;
  perRepositoryLimit?: number;
  publisher?: (input: { cwd: string; title: string; body: string; base: string; head: string }) => Promise<{ url: string }>;
  isProcessAlive?: (pid: number) => boolean;
}

export class Supervisor {
  private stopped = false;
  private readonly worktrees: WorktreeManager;

  constructor(private readonly options: SupervisorOptions) {
    this.worktrees = new WorktreeManager(resolve(options.dataRoot, "worktrees"));
  }

  async start(signal?: AbortSignal) {
    registerSupervisor(this.options.context, { id: this.options.id, processIdentity: { pid: process.pid }, version: "0.0.0", capabilities: { adapters: Object.keys(this.options.adapters).sort() } });
    this.reconcileProcesses();
    releaseExpiredRunActions(this.options.context);
    while (!this.stopped && !signal?.aborted) {
      heartbeatSupervisor(this.options.context, this.options.id);
      const worked = await this.runOnce(signal);
      if (!worked) await delay(this.options.pollMs ?? 250, signal);
    }
  }

  stop() { this.stopped = true; }

  private reconcileProcesses() {
    for (const run of listRuns(this.options.context)) {
      if (run.completedAt) continue;
      for (const participant of run.participants.filter((candidate) => candidate.state === "running")) {
        const pid = participant.processIdentity && typeof participant.processIdentity === "object" ? (participant.processIdentity as { pid?: unknown }).pid : null;
        if (typeof pid === "number" && !(this.options.isProcessAlive ?? processAlive)(pid)) recordProcessExit(this.options.context, { run: run.id, participantId: participant.id, exitCode: null, structuredResult: null });
      }
    }
  }

  async runOnce(signal?: AbortSignal) {
    this.detectStalls();
    releaseExpiredRunActions(this.options.context);
    const action = claimRunAction(this.options.context, { supervisorId: this.options.id, leaseMs: this.options.leaseMs, globalLimit: this.options.globalLimit, perRepositoryLimit: this.options.perRepositoryLimit });
    if (!action) return false;
    const heartbeat = setInterval(() => {
      try {
        heartbeatRunAction(this.options.context, { actionId: action.id, supervisorId: this.options.id, leaseMs: this.options.leaseMs });
        if (action.kind === "run_participant") {
          const role = String((action.payload as { role?: unknown }).role);
          const participant = getRun(this.options.context, action.runId).participants.find((candidate) => candidate.attemptId === action.attemptId && candidate.role === role && candidate.state === "running");
          if (participant) heartbeatRunParticipant(this.options.context, { run: action.runId, participantId: participant.id });
        }
      } catch { /* Completion or lease loss is handled by the main action path. */ }
    }, Math.max(250, Math.floor((this.options.leaseMs ?? 30_000) / 3)));
    try {
      const result = await this.perform(action, signal);
      completeRunAction(this.options.context, { actionId: action.id, supervisorId: this.options.id, result });
      if (action.kind === "graceful_stop" || action.kind === "force_stop") confirmRunStopped(this.options.context, action.runId);
    } catch (error) {
      failRunAction(this.options.context, { actionId: action.id, supervisorId: this.options.id, error: { message: error instanceof Error ? error.message : String(error) } });
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private detectStalls() {
    const now = this.options.context.clock.now().getTime();
    for (const run of listRuns(this.options.context, { state: "running" })) {
      const threshold = (run.resolvedConfiguration as { profile?: { configuration?: { stallThresholdMs?: number } } }).profile?.configuration?.stallThresholdMs ?? 300_000;
      if (now - new Date(run.lastProgressAt).getTime() >= threshold) markRunStalled(this.options.context, run.id);
    }
  }

  private async perform(action: NonNullable<ReturnType<typeof claimRunAction>>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const run = getRun(this.options.context, action.runId);
    if (action.kind === "provision_worktree") {
      const repositories = (action.payload as { repositories: Array<{ path: string; worktreePath: string; branch: string; baseCommit: string }> }).repositories;
      const worktrees = repositories.map((repository) => this.worktrees.provision({ repositoryPath: repository.path, worktreePath: repository.worktreePath, branch: repository.branch, baseCommit: repository.baseCommit }));
      for (const worktree of worktrees) recordArtifact(this.options.context, { run: run.id, attemptId: action.attemptId, kind: "worktree", title: `Managed worktree ${worktree.branch}`, localPath: worktree.path, metadata: { branch: worktree.branch, commit: worktree.commit, adopted: worktree.adopted } });
      return { worktrees };
    }
    if (action.kind === "run_participant") return await this.runParticipant(action, signal);
    if (action.kind === "resume_participant" || action.kind === "nudge_participant" || action.kind === "deliver_input") return await this.controlParticipant(action, signal);
    if (action.kind === "setup_command") {
      const command = (action.payload as { command: Parameters<typeof executeCommand>[0] }).command;
      const logPath = resolve(this.options.dataRoot, "runs", run.id, `${action.attemptId}-setup.log`);
      const execution = await executeCommand(command, { cwd: run.worktreePath, logPath, environment: process.env, signal });
      const artifact = recordArtifact(this.options.context, { run: run.id, attemptId: action.attemptId, kind: "setup_log", title: "Setup command log", localPath: logPath, sha256: sha256File(logPath), metadata: { private: true } });
      if (execution.exitCode !== 0) throw new Error(`Setup command failed with exit code ${execution.exitCode}; log artifact ${artifact.id}.`);
      return { exitCode: execution.exitCode, logArtifactId: artifact.id };
    }
    if (action.kind === "verify_commands") return await this.verify(action, signal);
    if (action.kind === "finalize") return this.finalize(run);
    if (action.kind === "push_branch") {
      execFileSync("git", ["-C", run.worktreePath, "push", "-u", "origin", run.branch], { stdio: ["ignore", "pipe", "pipe"] });
      return { branch: run.branch, commitSha: git(run.worktreePath, "rev-parse", "HEAD") };
    }
    if (action.kind === "publish_draft_pr") {
      const issue = (run.resolvedConfiguration as { issue: { identifier: string; title: string } }).issue;
      return await (this.options.publisher ?? publishDraftPullRequest)({ cwd: run.worktreePath, title: `${issue.identifier}: ${issue.title}`, body: `Autonomous coding run ${run.id}.\n\nVerification and review evidence are recorded in Issue Tracker.`, base: run.baseRef, head: run.branch });
    }
    if (action.kind === "graceful_stop" || action.kind === "force_stop") {
      const force = action.kind === "force_stop";
      const signaled: number[] = [];
      for (const participant of run.participants.filter((candidate) => ["running", "waiting"].includes(candidate.state))) {
        const pid = participant.processIdentity && typeof participant.processIdentity === "object" ? (participant.processIdentity as { pid?: unknown }).pid : null;
        if (typeof pid === "number" && pid !== process.pid && (this.options.isProcessAlive ?? processAlive)(pid)) { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); signaled.push(pid); }
      }
      return { stopped: true, force, signaled };
    }
    if (action.kind === "remove_raw_logs") {
      const paths = (action.payload as { paths: string[] }).paths;
      for (const path of paths) { assertContained(resolve(this.options.dataRoot, "runs"), path); if (existsSync(path)) rmSync(path); }
      return { removed: paths };
    }
    if (action.kind === "remove_worktree") {
      const paths = (action.payload as { paths: string[] }).paths;
      const repositories = (run.resolvedConfiguration as { repositories: Array<{ path: string; worktreePath: string }> }).repositories;
      for (const path of paths) {
        const repository = repositories.find((candidate) => resolve(candidate.worktreePath) === resolve(path));
        if (!repository) throw new Error(`Cleanup target ${path} is not owned by run ${run.id}.`);
        this.worktrees.remove({ repositoryPath: repository.path, worktreePath: path, active: false, allowUnmerged: (action.payload as { allowUnmerged?: boolean }).allowUnmerged });
      }
      return { removed: paths };
    }
    throw new Error(`Unsupported durable action ${action.kind}.`);
  }

  private async runParticipant(action: NonNullable<ReturnType<typeof claimRunAction>>, signal?: AbortSignal) {
    const run = getRun(this.options.context, action.runId);
    const role = String((action.payload as { role?: unknown }).role);
    const snapshot = run.resolvedConfiguration as { profile: { configuration: { roles: Record<string, string> } }; roleAssignments?: Record<string, { engineName: string; options: EngineDefinition | null }> };
    const engineName = String(snapshot.profile.configuration.roles[role]);
    const engine = snapshot.roleAssignments?.[role]?.options;
    if (!engine) throw new Error(`The immutable engine snapshot for ${engineName} is unavailable.`);
    const adapter = this.options.adapters[engine.adapter];
    if (!adapter) throw new Error(`Adapter ${engine.adapter} is unavailable.`);
    let participant = run.participants.find((candidate) => candidate.attemptId === action.attemptId && candidate.role === role && !candidate.completedAt);
    if (!participant) participant = startRunParticipant(this.options.context, { run: run.id, attemptId: action.attemptId!, role, actor: engineName, adapter: engine.adapter, requestedModel: engine.model, capabilities: { ...adapter.capabilities } });
    const resolved = run.resolvedConfiguration as { issue: unknown; repositories: Array<{ baseCommit: string; instructions?: Record<string, string> }> };
    const prompt = `Execute this Issue Tracker work order. Your final response must be one JSON object (not Markdown) with role, summary, files, tests, risks, findings, verifiedTestsPassed, and riskNotes fields. Planner results must also include risk (low, medium, or high) and estimatedSize.\n${JSON.stringify({ workflow: run.workflow, phase: run.phase, role, issue: resolved.issue, immutableBaseCommit: resolved.repositories[0]?.baseCommit, repositoryInstructions: resolved.repositories[0]?.instructions ?? {}, input: action.payload })}`;
    const result = await adapter.run({ participantId: participant.id, role, executable: engine.executable, model: engine.model, workingDirectory: run.worktreePath, prompt, options: engine, env: inheritedEnvironment(engine.envNames), onProcess: (pid) => recordParticipantProcess(this.options.context, { run: run.id, participantId: participant!.id, pid }) }, signal);
    const ingested = this.ingestParticipantResult(run, participant, result, action.payload as Record<string, unknown>);
    return { role, ...ingested };
  }

  private ingestParticipantResult(run: ReturnType<typeof getRun>, participant: ReturnType<typeof getRun>["participants"][number], result: ProviderResult, actionPayload: Record<string, unknown> = {}) {
    const role = participant.role;
    recordProviderEvent(this.options.context, { run: run.id, attemptId: participant.attemptId, participantId: participant.id, providerEventId: "session", type: "participant.session", data: { sessionId: result.sessionId, actualModel: result.actualModel }, progress: true });
    for (const event of result.events) recordProviderEvent(this.options.context, { run: run.id, attemptId: participant.attemptId, participantId: participant.id, ...event });
    const log = writePrivateLog(resolve(this.options.dataRoot, "runs", run.id, `${participant.id}.jsonl`), result.rawLog);
    recordArtifact(this.options.context, { run: run.id, attemptId: participant.attemptId, kind: "raw_log", title: `${role} provider log`, localPath: log.path, sha256: log.sha256, metadata: { private: true, participantId: participant.id } });
    if ((role === "bindingReviewer" || role === "adversarialReviewer") && result.structuredResult) {
      const findings = Array.isArray(result.structuredResult.findings) ? result.structuredResult.findings : [];
      for (const finding of findings) {
        if (!finding || typeof finding !== "object") continue;
        const value = finding as Record<string, unknown>;
        if (!["info", "warning", "blocking"].includes(String(value.severity)) || typeof value.summary !== "string" || typeof value.evidence !== "string") continue;
        recordReviewFinding(this.options.context, { run: run.id, participantId: participant.id, severity: value.severity as "info" | "warning" | "blocking", source: role === "bindingReviewer" ? "binding" : "adversarial", file: typeof value.file === "string" ? value.file : null, location: typeof value.location === "string" ? value.location : null, summary: value.summary, evidence: value.evidence });
      }
    }
    const addressed = (actionPayload as { addressFindingIds?: unknown }).addressFindingIds;
    if (role === "implementer" && result.structuredResult && Array.isArray(addressed)) resolveReviewFindings(this.options.context, { run: run.id, findingIds: addressed.filter((id): id is string => typeof id === "string"), resolution: "addressed_by_implementer" });
    recordProcessExit(this.options.context, { run: run.id, participantId: participant.id, exitCode: result.exitCode, structuredResult: result.structuredResult });
    return { sessionId: result.sessionId, actualModel: result.actualModel, exitCode: result.exitCode, structuredResult: result.structuredResult };
  }

  private async controlParticipant(action: NonNullable<ReturnType<typeof claimRunAction>>, signal?: AbortSignal) {
    const run = getRun(this.options.context, action.runId);
    const payload = action.payload as { participantId?: unknown; providerSessionId?: unknown; message?: unknown };
    const participant = run.participants.find((candidate) => candidate.id === payload.participantId && candidate.attemptId === action.attemptId);
    if (!participant || typeof payload.providerSessionId !== "string" || participant.providerSessionId !== payload.providerSessionId) throw new Error("The participant session is no longer current.");
    const snapshot = run.resolvedConfiguration as { roleAssignments?: Record<string, { engineName: string; options: EngineDefinition | null }> };
    const assignment = snapshot.roleAssignments?.[participant.role];
    const engine = assignment?.options;
    if (!engine) throw new Error(`The immutable engine snapshot for ${participant.role} is unavailable.`);
    const adapter = this.options.adapters[engine.adapter];
    if (!adapter) throw new Error(`Adapter ${engine.adapter} is unavailable.`);
    const operation = action.kind === "resume_participant" ? adapter.resume : adapter.redirect ?? (action.kind === "deliver_input" ? adapter.resume : undefined);
    if (!operation) throw new Error(`Adapter ${engine.adapter} cannot ${action.kind === "resume_participant" ? "resume" : action.kind === "deliver_input" ? "deliver input to" : "redirect"} a session.`);
    const prompt = action.kind === "resume_participant"
      ? "Resume the interrupted work from the durable run state. Return the required structured result when complete."
      : action.kind === "deliver_input"
        ? `Continue the exact session using this attributed response: ${String((action.payload as { response?: unknown }).response ?? "")}`
        : String(payload.message ?? "Re-evaluate progress and continue the assigned work.");
    const result = await operation.call(adapter, { participantId: participant.id, role: participant.role, executable: engine.executable, model: engine.model, workingDirectory: run.worktreePath, prompt, options: engine, env: inheritedEnvironment(engine.envNames), onProcess: (pid) => recordParticipantProcess(this.options.context, { run: run.id, participantId: participant.id, pid }) }, payload.providerSessionId, signal);
    return { role: participant.role, ...this.ingestParticipantResult(run, participant, result) };
  }

  private async verify(action: NonNullable<ReturnType<typeof claimRunAction>>, signal?: AbortSignal) {
    const run = getRun(this.options.context, action.runId);
    const repositories = (run.resolvedConfiguration as { repositories: Array<{ id: string; name: string; worktreePath: string; commands: { test: Parameters<typeof executeCommand>[0]; verification: Parameters<typeof executeCommand>[0] } }> }).repositories;
    const results = [];
    for (const repository of repositories) {
      const commitSha = git(repository.worktreePath, "rev-parse", "HEAD");
      for (const [name, command] of [["test", repository.commands.test], ["verification", repository.commands.verification]] as const) {
        const logPath = resolve(this.options.dataRoot, "runs", run.id, `${action.attemptId}-${repository.id}-${name}.log`);
        const execution = await executeCommand(command, { cwd: repository.worktreePath, logPath, environment: process.env, signal });
        const artifact = recordArtifact(this.options.context, { run: run.id, attemptId: action.attemptId, kind: "verification_log", title: `${repository.name} ${name} command log`, localPath: logPath, sha256: sha256File(logPath), metadata: { private: true, command: name, repositoryId: repository.id } });
        const selfReport = (action.payload as { selfReport?: { verifiedTestsPassed?: unknown } }).selfReport;
        const classification = execution.exitCode === 0 ? "clean" : selfReport?.verifiedTestsPassed === true ? "audit_drift" : "honest_partial";
        const verification = recordVerification(this.options.context, { run: run.id, attemptId: action.attemptId!, commitSha, command, startedAt: execution.startedAt, completedAt: execution.completedAt, exitCode: execution.exitCode, classification, logArtifactId: artifact.id, summary: { command: name, repositoryId: repository.id, signal: execution.signal } });
        results.push({ verificationId: verification.id, repositoryId: repository.id, commitSha, command: name, exitCode: execution.exitCode, classification });
      }
    }
    return { commitSha: results[0]?.commitSha ?? run.baseCommit, results, clean: results.every((result) => result.classification === "clean") };
  }

  private finalize(run: ReturnType<typeof getRun>) {
    const commitSha = git(run.worktreePath, "rev-parse", "HEAD");
    const filesChanged = git(run.worktreePath, "diff", "--name-only", run.baseCommit, commitSha).split(/\r?\n/).filter(Boolean).sort();
    const diffSize = Number(git(run.worktreePath, "diff", "--numstat", run.baseCommit, commitSha).split(/\r?\n/).filter(Boolean).reduce((sum, line) => sum + line.split("\t").slice(0, 2).reduce((count, value) => count + (Number(value) || 0), 0), 0));
    return { commitSha, filesChanged, diffSize, branch: run.branch };
  }
}

function git(cwd: string, ...args: string[]) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolveDelay) => {
    const timeout = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timeout); resolveDelay(); }, { once: true });
  });
}

function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

function inheritedEnvironment(names: string[]) {
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}
