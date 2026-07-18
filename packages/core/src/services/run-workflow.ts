import { createHash } from "node:crypto";

import { and, asc, eq, or } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { activity, agentRuns, attachments, runActions, runAttempts, runInputRequests, runParticipants, runReviewFindings, runVerifications } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import type { CommandSpec } from "../schemas/repository.js";
import { participantResultSchema, type RunState } from "../schemas/run.js";
import { appendRunEventInTransaction, getRun } from "./run.js";

export function startRunParticipant(context: ServiceContext, input: { run: string; attemptId: string; role: string; actor: string; adapter: string; requestedModel: string; capabilities: Record<string, unknown> }) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    if (["succeeded", "partial", "failed", "canceled", "crashed"].includes(run.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "A terminal run cannot start a participant.");
    if (!run.attempts.some((attempt) => attempt.id === input.attemptId && !attempt.completedAt)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "A participant can start only on the active run attempt.");
    const participant = { id: uuid(), runId: run.id, attemptId: input.attemptId, actor: input.actor, role: input.role, adapter: input.adapter, requestedModel: input.requestedModel, actualModel: null, providerSessionId: null, capabilities: input.capabilities, processIdentity: null, state: "queued" as const, startedAt: null, lastHeartbeatAt: null, completedAt: null };
    txContext.db.insert(runParticipants).values(participant).run();
    appendRunEventInTransaction(txContext, { runId: run.id, attemptId: input.attemptId, participantId: participant.id, type: "participant.created", data: { role: input.role, adapter: input.adapter, requestedModel: input.requestedModel } });
    return participant;
  });
}

export function recordProviderEvent(context: ServiceContext, input: { run: string; attemptId: string; participantId: string; providerEventId: string; type: string; data: Record<string, unknown>; progress?: boolean }) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    const activeAttempt = run.attempts.find((attempt) => !attempt.completedAt);
    if (activeAttempt && input.attemptId !== activeAttempt.id) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Provider event came from a stale run attempt and was rejected.", { eventAttemptId: input.attemptId, activeAttemptId: activeAttempt.id });
    const participant = txContext.db.query.runParticipants.findFirst({ where: and(eq(runParticipants.id, input.participantId), eq(runParticipants.runId, input.run), eq(runParticipants.attemptId, input.attemptId)) }).sync();
    if (!participant) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Provider event targeted the wrong run, attempt, or participant.");
    const now = txContext.clock.now().toISOString();
    const sessionId = typeof input.data.sessionId === "string" ? input.data.sessionId : typeof input.data.session_id === "string" ? input.data.session_id : undefined;
    const actualModel = typeof input.data.actualModel === "string" ? input.data.actualModel : typeof input.data.model === "string" ? input.data.model : undefined;
    txContext.db.update(runParticipants).set({ state: participant.state === "queued" ? "running" : participant.state, startedAt: participant.startedAt ?? now, lastHeartbeatAt: now, ...(sessionId ? { providerSessionId: sessionId } : {}), ...(actualModel ? { actualModel } : {}) }).where(eq(runParticipants.id, participant.id)).run();
    const event = appendRunEventInTransaction(txContext, { runId: input.run, attemptId: input.attemptId, participantId: input.participantId, providerEventId: input.providerEventId, type: input.type, data: input.data, progress: input.progress });
    if (input.progress && run.state === "stalled") {
      txContext.db.update(agentRuns).set({ state: "running", updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
      appendRunEventInTransaction(txContext, { runId: run.id, attemptId: input.attemptId, participantId: input.participantId, type: "run.recovered", data: { from: "stalled", reason: "provider_progress" }, progress: true });
    }
    return event;
  });
}

export function heartbeatRunParticipant(context: ServiceContext, input: { run: string; participantId: string }) {
  const participant = context.db.query.runParticipants.findFirst({ where: and(eq(runParticipants.id, input.participantId), eq(runParticipants.runId, input.run)) }).sync();
  if (!participant || participant.state !== "running") throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Only a live participant can heartbeat.");
  context.db.update(runParticipants).set({ lastHeartbeatAt: context.clock.now().toISOString() }).where(eq(runParticipants.id, participant.id)).run();
  return context.db.query.runParticipants.findFirst({ where: eq(runParticipants.id, participant.id) }).sync()!;
}

export function recordParticipantProcess(context: ServiceContext, input: { run: string; participantId: string; pid: number }) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    const participant = txContext.db.query.runParticipants.findFirst({ where: and(eq(runParticipants.id, input.participantId), eq(runParticipants.runId, input.run)) }).sync();
    if (!participant) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Process identity targeted an unknown participant.");
    if (!run.attempts.some((attempt) => attempt.id === participant.attemptId && !attempt.completedAt)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Process identity came from a stale run attempt and was rejected.");
    const now = txContext.clock.now().toISOString();
    txContext.db.update(runParticipants).set({ processIdentity: { pid: input.pid }, state: "running", startedAt: participant.startedAt ?? now, lastHeartbeatAt: now }).where(eq(runParticipants.id, participant.id)).run();
    appendRunEventInTransaction(txContext, { runId: input.run, attemptId: participant.attemptId, participantId: participant.id, type: "participant.process_started", data: { pid: input.pid }, progress: true });
    return txContext.db.query.runParticipants.findFirst({ where: eq(runParticipants.id, participant.id) }).sync()!;
  });
}

export function recordProcessExit(context: ServiceContext, input: { run: string; participantId: string; exitCode: number | null; structuredResult?: Record<string, unknown> | null }) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    const participant = txContext.db.query.runParticipants.findFirst({ where: and(eq(runParticipants.id, input.participantId), eq(runParticipants.runId, input.run)) }).sync();
    if (!participant) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Process exit targeted an unknown participant.");
    const activeAttempt = run.attempts.find((attempt) => !attempt.completedAt);
    if (activeAttempt && participant.attemptId !== activeAttempt.id) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Process exit came from a stale run attempt and was rejected.", { participantAttemptId: participant.attemptId, activeAttemptId: activeAttempt.id });
    const now = txContext.clock.now().toISOString();
    const parsedResult = participantResultSchema.safeParse(input.structuredResult);
    const structuredResult = parsedResult.success && parsedResult.data.role === participant.role ? parsedResult.data : null;
    const clean = input.exitCode === 0 && structuredResult !== null;
    txContext.db.update(runParticipants).set({ state: clean ? "succeeded" : input.exitCode === null ? "crashed" : "failed", completedAt: now }).where(eq(runParticipants.id, participant.id)).run();
    appendRunEventInTransaction(txContext, { runId: run.id, attemptId: participant.attemptId, participantId: participant.id, type: "participant.exited", data: { exitCode: input.exitCode, structuredResult }, progress: true });
    if (!clean && !["succeeded", "partial", "failed", "canceled", "crashed"].includes(run.state)) {
      const state: RunState = input.exitCode === null ? "crashed" : "failed";
      const outcome = input.exitCode !== 0 ? "provider_failed" : input.structuredResult == null ? "missing_structured_result" : "invalid_structured_result";
      txContext.db.update(agentRuns).set({ state, outcome, error: { exitCode: input.exitCode, ...(parsedResult.success ? { expectedRole: participant.role, receivedRole: parsedResult.data.role } : { structuredResultIssues: parsedResult.error.issues }) }, completedAt: now, updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
      txContext.db.update(runAttempts).set({ state, error: { exitCode: input.exitCode }, completedAt: now }).where(eq(runAttempts.id, participant.attemptId)).run();
      txContext.db.update(runParticipants).set({ state: "failed", completedAt: now }).where(and(eq(runParticipants.runId, run.id), or(eq(runParticipants.state, "queued"), eq(runParticipants.state, "running"), eq(runParticipants.state, "waiting")))).run();
      txContext.db.update(runInputRequests).set({ state: "expired", respondedAt: now }).where(and(eq(runInputRequests.runId, run.id), eq(runInputRequests.state, "pending"))).run();
      txContext.db.update(runActions).set({ state: "canceled", error: { reason: outcome }, completedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(and(eq(runActions.runId, run.id), eq(runActions.state, "queued"))).run();
      appendRunEventInTransaction(txContext, { runId: run.id, attemptId: participant.attemptId, participantId: participant.id, type: `run.${state}`, data: { reason: outcome }, progress: true });
    }
    return getRun(txContext, run.id);
  });
}

export function recordVerification(context: ServiceContext, input: {
  run: string; attemptId: string; commitSha: string; command: CommandSpec; startedAt: string; completedAt: string;
  exitCode: number | null; classification: "clean" | "honest_partial" | "fixable_partial" | "audit_drift" | "blocked" | "engine_failure";
  logArtifactId?: string | null; summary: Record<string, unknown>;
}) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    if (run.phase !== "verify" && run.phase !== "finalize") throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Verification evidence can only be recorded during verify or finalize.");
    if (input.classification === "clean" && input.exitCode !== 0) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "A clean verification must have exit code 0.");
    const verification = { id: uuid(), runId: run.id, attemptId: input.attemptId, commitSha: input.commitSha, command: input.command, startedAt: input.startedAt, completedAt: input.completedAt, exitCode: input.exitCode, classification: input.classification, logArtifactId: input.logArtifactId ?? null, summary: input.summary };
    txContext.db.insert(runVerifications).values(verification).run();
    appendRunEventInTransaction(txContext, { runId: run.id, attemptId: input.attemptId, type: "verification.completed", data: { verificationId: verification.id, commitSha: input.commitSha, classification: input.classification, exitCode: input.exitCode }, progress: true });
    return verification;
  });
}

export function recordReviewFinding(context: ServiceContext, input: {
  run: string; participantId: string; severity: "info" | "warning" | "blocking"; source: "binding" | "adversarial";
  file?: string | null; location?: string | null; summary: string; evidence: string;
}) {
  return inTransaction(context, (txContext) => {
    const participant = txContext.db.query.runParticipants.findFirst({ where: and(eq(runParticipants.id, input.participantId), eq(runParticipants.runId, input.run)) }).sync();
    if (!participant || !["bindingReviewer", "adversarialReviewer"].includes(participant.role)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Review findings require a reviewer participant.");
    const fingerprint = createHash("sha256").update([input.source, input.file ?? "", input.location ?? "", input.summary, input.evidence].join("\0")).digest("hex");
    const row = { id: uuid(), runId: input.run, participantId: input.participantId, fingerprint, severity: input.severity, source: input.source, file: input.file ?? null, location: input.location ?? null, summary: input.summary, evidence: input.evidence, resolution: null, reconciliation: null, createdAt: txContext.clock.now().toISOString() };
    txContext.db.insert(runReviewFindings).values(row).onConflictDoNothing().run();
    appendRunEventInTransaction(txContext, { runId: input.run, attemptId: participant.attemptId, participantId: participant.id, type: "review.finding", data: { fingerprint, severity: input.severity, source: input.source, summary: input.summary }, progress: input.severity === "blocking" });
    return txContext.db.query.runReviewFindings.findFirst({ where: and(eq(runReviewFindings.runId, input.run), eq(runReviewFindings.participantId, input.participantId), eq(runReviewFindings.fingerprint, fingerprint)) }).sync()!;
  });
}

export function reconcileReview(context: ServiceContext, runId: string) {
  return inTransaction(context, (txContext) => {
    const findings = txContext.db.query.runReviewFindings.findMany({ where: eq(runReviewFindings.runId, runId), orderBy: [asc(runReviewFindings.createdAt), asc(runReviewFindings.id)] }).sync();
    for (const finding of findings) {
      const counterpart = findings.find((candidate) => candidate.id !== finding.id && candidate.source !== finding.source && candidate.file === finding.file && candidate.location === finding.location && candidate.severity === finding.severity);
      const reconciliation = counterpart ? "agreed" : finding.source === "binding" ? "binding_only" : "adversary_only";
      txContext.db.update(runReviewFindings).set({ reconciliation }).where(eq(runReviewFindings.id, finding.id)).run();
    }
    appendRunEventInTransaction(txContext, { runId, type: "review.reconciled", data: { agreed: findings.filter((finding) => findings.some((candidate) => candidate.id !== finding.id && candidate.source !== finding.source && candidate.file === finding.file && candidate.location === finding.location && candidate.severity === finding.severity)).length, total: findings.length }, progress: true });
    return txContext.db.query.runReviewFindings.findMany({ where: eq(runReviewFindings.runId, runId), orderBy: [asc(runReviewFindings.createdAt), asc(runReviewFindings.id)] }).sync();
  });
}

export function resolveReviewFindings(context: ServiceContext, input: { run: string; findingIds: string[]; resolution: string }) {
  return inTransaction(context, (txContext) => {
    for (const findingId of [...new Set(input.findingIds)].sort()) {
      const finding = txContext.db.query.runReviewFindings.findFirst({ where: and(eq(runReviewFindings.id, findingId), eq(runReviewFindings.runId, input.run)) }).sync();
      if (!finding) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Review finding ${findingId} was not found on run ${input.run}.`);
      txContext.db.update(runReviewFindings).set({ resolution: input.resolution }).where(eq(runReviewFindings.id, finding.id)).run();
    }
    appendRunEventInTransaction(txContext, { runId: input.run, type: "review.findings_resolved", data: { findingIds: [...new Set(input.findingIds)].sort(), resolution: input.resolution }, progress: true });
    return txContext.db.query.runReviewFindings.findMany({ where: eq(runReviewFindings.runId, input.run), orderBy: [asc(runReviewFindings.createdAt), asc(runReviewFindings.id)] }).sync();
  });
}

export function completeRunWorkflow(context: ServiceContext, input: {
  run: string; commitSha: string; filesChanged: string[]; diffSize: number; testsRun: string[]; testsFailed: string[]; riskNotes: string[];
  branch: string; pullRequestUrl?: string | null;
}) {
  if (!context.actor) throw new AppError(AppErrorCode.ACTOR_NOT_FOUND, "Completing a run requires an actor.");
  return inTransaction(context, (txContext) => completeRunWorkflowInTransaction(txContext, input));
}

export function completeRunWorkflowInTransaction(txContext: ServiceContext, input: {
  run: string; commitSha: string; filesChanged: string[]; diffSize: number; testsRun: string[]; testsFailed: string[]; riskNotes: string[];
  branch: string; pullRequestUrl?: string | null;
}) {
    if (!txContext.actor) throw new AppError(AppErrorCode.ACTOR_NOT_FOUND, "Completing a run requires an actor.");
    const run = getRun(txContext, input.run);
    if (run.phase !== "finalize" || run.state !== "running") throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Only a running run in finalize can complete.");
    if (input.branch !== run.branch) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Final branch does not match the immutable run branch.", { expected: run.branch, received: input.branch });
    if (input.testsFailed.length > 0) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "A run with reported test failures cannot succeed.", { testsFailed: input.testsFailed });
    const verificationActions = txContext.db.query.runActions.findMany({ where: and(eq(runActions.runId, run.id), eq(runActions.kind, "verify_commands")), orderBy: [asc(runActions.createdAt), asc(runActions.id)] }).sync().filter((action) => action.state === "completed");
    const verificationAction = verificationActions.at(-1);
    const verificationResults = verificationAction?.result && typeof verificationAction.result === "object" && Array.isArray((verificationAction.result as { results?: unknown }).results) ? (verificationAction.result as { results: Array<{ verificationId?: unknown; repositoryId?: unknown; commitSha?: unknown; command?: unknown; classification?: unknown; exitCode?: unknown }> }).results : [];
    const expectedVerificationCount = run.repositories.length * 2;
    const finalize = txContext.db.query.runActions.findMany({ where: and(eq(runActions.runId, run.id), eq(runActions.kind, "finalize")) }).sync().find((action) => action.state === "completed");
    if (!finalize) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Final artifact reconciliation has not completed.");
    const finalizedRepositories = finalize.result && typeof finalize.result === "object" && Array.isArray((finalize.result as { repositories?: unknown }).repositories)
      ? (finalize.result as { repositories: Array<{ repositoryId?: unknown; commitSha?: unknown; filesChanged?: unknown; diffSize?: unknown; branch?: unknown }> }).repositories
      : [];
    const finalizedByRepository = new Map(finalizedRepositories.map((result) => [result.repositoryId, result]));
    const primaryFinalized = finalizedByRepository.get(run.primaryRepositoryId);
    const repositoryCoverageIsExact = finalizedRepositories.length === run.repositories.length && finalizedByRepository.size === run.repositories.length && run.repositories.every((repository) => finalizedByRepository.has(repository.repositoryId));
    const verificationCoverageIsExact = run.repositories.every((repository) => {
      const finalized = finalizedByRepository.get(repository.repositoryId);
      const results = verificationResults.filter((result) => result.repositoryId === repository.repositoryId);
      return finalized && typeof finalized.commitSha === "string" && finalized.branch === repository.branch && results.length === 2 && new Set(results.map((result) => result.command)).size === 2 && results.some((result) => result.command === "test") && results.some((result) => result.command === "verification") && results.every((result) => result.commitSha === finalized.commitSha && result.classification === "clean" && result.exitCode === 0);
    });
    if (verificationResults.length !== expectedVerificationCount || !repositoryCoverageIsExact || !verificationCoverageIsExact || primaryFinalized?.commitSha !== input.commitSha) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Success requires the latest independent test and verification commands to be clean for every repository at the finalized commits.", { commitSha: input.commitSha, expectedVerificationCount, finalizedRepositories, results: verificationResults });
    const verificationIds = verificationResults.map((result) => String(result.verificationId));
    if (new Set(verificationIds).size !== verificationIds.length) throw new AppError(AppErrorCode.DATA_INTEGRITY, "Latest verification action references duplicate evidence rows.");
    const verificationRows = verificationResults.map((result) => {
      const row = txContext.db.query.runVerifications.findFirst({ where: eq(runVerifications.id, String(result.verificationId)) }).sync();
      if (!row || row.runId !== run.id || row.attemptId !== verificationAction?.attemptId || row.commitSha !== result.commitSha || row.classification !== result.classification || row.exitCode !== result.exitCode) {
        throw new AppError(AppErrorCode.DATA_INTEGRITY, "Latest verification action references missing or mismatched evidence.", { verificationId: result.verificationId ?? null });
      }
      return row;
    });
    const verification = verificationRows[0]!;
    const reviewers = txContext.db.query.runParticipants.findMany({ where: eq(runParticipants.runId, run.id) }).sync().filter((participant) => ["bindingReviewer", "adversarialReviewer"].includes(participant.role) && participant.state === "succeeded" && participant.providerSessionId);
    const implementers = txContext.db.query.runParticipants.findMany({ where: and(eq(runParticipants.runId, run.id), eq(runParticipants.role, "implementer")) }).sync();
    const hasBinding = reviewers.some((reviewer) => reviewer.role === "bindingReviewer");
    const hasAdversarial = reviewers.some((reviewer) => reviewer.role === "adversarialReviewer");
    const independentRoles = ["bindingReviewer", "adversarialReviewer"].every((role) => reviewers.some((reviewer) => reviewer.role === role && !implementers.some((implementer) => implementer.id === reviewer.id || (implementer.providerSessionId && implementer.providerSessionId === reviewer.providerSessionId))));
    if (!hasBinding || !hasAdversarial || !independentRoles) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Success requires binding and adversarial review from sessions independent of the implementer.");
    const blocking = txContext.db.query.runReviewFindings.findMany({ where: and(eq(runReviewFindings.runId, run.id), eq(runReviewFindings.severity, "blocking")) }).sync().filter((finding) => !finding.resolution);
    if (blocking.length) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Unresolved blocking review findings prevent success.", { findings: blocking.map((finding) => finding.id) });
    const unreconciled = txContext.db.query.runReviewFindings.findMany({ where: eq(runReviewFindings.runId, run.id) }).sync().filter((finding) => !finding.reconciliation);
    if (unreconciled.length) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Review findings must be reconciled before success.", { findings: unreconciled.map((finding) => finding.id) });
    if (!finalize.result || typeof finalize.result !== "object" || (finalize.result as { commitSha?: unknown }).commitSha !== input.commitSha) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Finalized commit does not match the requested completion commit.", { commitSha: input.commitSha });
    const published = txContext.db.query.runActions.findMany({ where: and(eq(runActions.runId, run.id), eq(runActions.kind, "publish_draft_pr")) }).sync().find((action) => action.state === "completed");
    if (run.pendingActions.some((action) => action.kind === "push_branch" || action.kind === "publish_draft_pr")) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Publication actions must reconcile before workflow completion.");
    const publishedUrl = published?.result && typeof published.result === "object" && typeof (published.result as { url?: unknown }).url === "string" ? (published.result as { url: string }).url : null;
    const pullRequestUrl = input.pullRequestUrl ?? publishedUrl;
    const policies = (run.resolvedConfiguration as { policies?: { draftPr?: string } }).policies;
    if (policies?.draftPr === "automatic" && !pullRequestUrl) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "The resolved profile requires a draft pull request artifact before success.");
    const now = txContext.clock.now().toISOString();
    const result = { filesChanged: [...input.filesChanged].sort(), diffSize: input.diffSize, testsRun: input.testsRun, testsFailed: input.testsFailed, riskNotes: input.riskNotes, branch: input.branch, commitSha: input.commitSha, pullRequestUrl, verificationId: verification.id };
    txContext.db.update(agentRuns).set({ phase: "complete", state: "succeeded", outcome: "verified", completedAt: now, updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
    const activeAttempt = run.attempts.find((attempt) => !attempt.completedAt);
    if (activeAttempt) txContext.db.update(runAttempts).set({ state: "succeeded", result, completedAt: now }).where(eq(runAttempts.id, activeAttempt.id)).run();
    const attachmentRows = [
      { kind: "branch" as const, title: `${run.id} branch`, url: null, repoPath: run.worktreePath, remote: null, branchName: input.branch, commitSha: null },
      { kind: "commit" as const, title: `${run.id} verified commit`, url: null, repoPath: run.worktreePath, remote: null, branchName: input.branch, commitSha: input.commitSha },
      ...(pullRequestUrl && !published ? [{ kind: "pr" as const, title: `${run.id} draft pull request`, url: pullRequestUrl, repoPath: null, remote: null, branchName: input.branch, commitSha: input.commitSha }] : [])
    ];
    for (const attachment of attachmentRows) txContext.db.insert(attachments).values({ id: uuid(), issueId: run.issueId, ...attachment, createdAt: now }).run();
    txContext.db.insert(activity).values({ id: uuid(), issueId: run.issueId, actorId: txContext.actor!.id, action: "run_completed", data: { runId: run.id, outcome: "verified", branch: input.branch, commitSha: input.commitSha, pullRequestUrl }, createdAt: now }).run();
    appendRunEventInTransaction(txContext, { runId: run.id, attemptId: activeAttempt?.id, type: "run.succeeded", data: result, progress: true });
    return getRun(txContext, run.id);
}

export function requestRunPublication(context: ServiceContext, input: { run: string; publishDraftPr: boolean; confirmed: boolean }) {
  if (!input.confirmed) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "Push and draft pull-request publication require explicit confirmation.");
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    if (run.phase !== "finalize" || run.state !== "running") throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Only verified work in finalize can be published.");
    const policies = (run.resolvedConfiguration as { policies?: { push?: string; draftPr?: string } }).policies;
    if (policies?.push === "never") throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "The resolved profile forbids push.");
    if (input.publishDraftPr && policies?.draftPr === "never") throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "The resolved profile forbids draft pull-request publication.");
    const latestVerification = txContext.db.query.runActions.findMany({ where: and(eq(runActions.runId, run.id), eq(runActions.kind, "verify_commands")), orderBy: [asc(runActions.createdAt), asc(runActions.id)] }).sync().filter((action) => action.state === "completed").at(-1);
    const results = latestVerification?.result && typeof latestVerification.result === "object" && Array.isArray((latestVerification.result as { results?: unknown }).results) ? (latestVerification.result as { results: Array<{ classification?: unknown; exitCode?: unknown }> }).results : [];
    if (results.length !== run.repositories.length * 2 || results.some((result) => result.classification !== "clean" || result.exitCode !== 0)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Publication requires the latest independent verification to be clean for every repository.");
    const now = txContext.clock.now().toISOString();
    const action = { id: uuid(), runId: run.id, attemptId: run.attempts.find((attempt) => !attempt.completedAt)?.id ?? null, kind: "push_branch", idempotencyKey: `${run.id}:push:${run.branch}`, payload: { branch: run.branch, publishDraftPr: input.publishDraftPr }, state: "queued" as const, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null };
    txContext.db.insert(runActions).values(action).onConflictDoNothing().run();
    appendRunEventInTransaction(txContext, { runId: run.id, type: "publication.requested", data: { branch: run.branch, publishDraftPr: input.publishDraftPr } });
    return txContext.db.query.runActions.findFirst({ where: eq(runActions.idempotencyKey, action.idempotencyKey) }).sync()!;
  });
}


export function failRun(context: ServiceContext, runId: string, state: Extract<RunState, "partial" | "failed" | "canceled" | "crashed">, error: Record<string, unknown>, outcome: string) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, runId);
    if (["succeeded", "partial", "failed", "canceled", "crashed"].includes(run.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Terminal runs are immutable.");
    const now = txContext.clock.now().toISOString();
    txContext.db.update(agentRuns).set({ state, outcome, error, completedAt: now, updatedAt: now }).where(eq(agentRuns.id, runId)).run();
    const attempt = run.attempts.find((candidate) => !candidate.completedAt);
    if (attempt) txContext.db.update(runAttempts).set({ state: state === "partial" ? "failed" : state, error, completedAt: now }).where(eq(runAttempts.id, attempt.id)).run();
    const participantState = state === "canceled" ? "stopped" : state === "crashed" ? "crashed" : "failed";
    txContext.db.update(runParticipants).set({ state: participantState, completedAt: now }).where(and(eq(runParticipants.runId, runId), or(eq(runParticipants.state, "queued"), eq(runParticipants.state, "running"), eq(runParticipants.state, "waiting")))).run();
    txContext.db.update(runInputRequests).set({ state: "expired", respondedAt: now }).where(and(eq(runInputRequests.runId, runId), eq(runInputRequests.state, "pending"))).run();
    txContext.db.update(runActions).set({ state: "canceled", error: { reason: "run_terminal", outcome }, completedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(and(eq(runActions.runId, runId), or(eq(runActions.state, "queued"), eq(runActions.state, "claimed")))).run();
    appendRunEventInTransaction(txContext, { runId, attemptId: attempt?.id, type: `run.${state}`, data: { outcome, error }, progress: true });
    return getRun(txContext, runId);
  });
}

export const cancelRun = (context: ServiceContext, runId: string, error: Record<string, unknown> = {}) => failRun(context, runId, "canceled", error, "canceled");
export const markRunCrashed = (context: ServiceContext, runId: string, error: Record<string, unknown>) => failRun(context, runId, "crashed", error, "crashed");
