import { and, asc, eq, gt, lte, or } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { activity, agentRuns, attachments, issues, runActions, runArtifacts, runAttempts, runReviewFindings, supervisorInstances, workflowStates } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { appendRunEventInTransaction, getRun } from "./run.js";
import { completeRunWorkflowInTransaction } from "./run-workflow.js";

export interface ClaimRunActionInput { supervisorId: string; leaseMs?: number; globalLimit?: number; perRepositoryLimit?: number }

export function registerSupervisor(context: ServiceContext, input: { id: string; processIdentity: Record<string, unknown>; version: string; capabilities: Record<string, unknown> }) {
  return inTransaction(context, (txContext) => {
    const now = txContext.clock.now().toISOString();
    txContext.db.insert(supervisorInstances).values({ id: input.id, processIdentity: input.processIdentity, version: input.version, capabilities: input.capabilities, startedAt: now, lastHeartbeatAt: now }).onConflictDoUpdate({ target: supervisorInstances.id, set: { processIdentity: input.processIdentity, version: input.version, capabilities: input.capabilities, lastHeartbeatAt: now } }).run();
    return txContext.db.query.supervisorInstances.findFirst({ where: eq(supervisorInstances.id, input.id) }).sync()!;
  });
}

export function heartbeatSupervisor(context: ServiceContext, id: string) {
  const now = context.clock.now().toISOString();
  context.db.update(supervisorInstances).set({ lastHeartbeatAt: now }).where(eq(supervisorInstances.id, id)).run();
  return context.db.query.supervisorInstances.findFirst({ where: eq(supervisorInstances.id, id) }).sync();
}

export function getSupervisorHealth(context: ServiceContext, staleAfterMs = 30_000) {
  const cutoff = new Date(context.clock.now().getTime() - staleAfterMs).toISOString();
  const instances = context.db.query.supervisorInstances.findMany({ orderBy: [asc(supervisorInstances.startedAt), asc(supervisorInstances.id)] }).sync();
  return { healthy: instances.some((instance) => instance.lastHeartbeatAt >= cutoff), instances: instances.map((instance) => ({ ...instance, stale: instance.lastHeartbeatAt < cutoff })) };
}

export function claimRunAction(context: ServiceContext, input: ClaimRunActionInput) {
  return inTransaction(context, (txContext) => {
    const nowDate = txContext.clock.now();
    const now = nowDate.toISOString();
    const candidates = txContext.db.query.runActions.findMany({
      where: or(eq(runActions.state, "queued"), and(eq(runActions.state, "claimed"), lte(runActions.leaseExpiresAt, now))),
      orderBy: [asc(runActions.createdAt), asc(runActions.id)]
    }).sync();
    const claimed = txContext.db.query.runActions.findMany({ where: and(eq(runActions.state, "claimed"), gt(runActions.leaseExpiresAt, now)) }).sync();
    if (claimed.length >= (input.globalLimit ?? 4)) return null;
    const repositoryCounts = new Map<string, number>();
    for (const active of claimed) {
      const activeRun = txContext.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, active.runId) }).sync();
      if (activeRun) repositoryCounts.set(activeRun.primaryRepositoryId, (repositoryCounts.get(activeRun.primaryRepositoryId) ?? 0) + 1);
    }
    const action = candidates.sort((left, right) => Number(right.state === "claimed") - Number(left.state === "claimed") || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).find((candidate) => {
      const candidateRun = txContext.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, candidate.runId) }).sync();
      return candidateRun && (repositoryCounts.get(candidateRun.primaryRepositoryId) ?? 0) < (input.perRepositoryLimit ?? 2);
    });
    if (!action) return null;
    const leaseExpiresAt = new Date(nowDate.getTime() + (input.leaseMs ?? 30_000)).toISOString();
    txContext.db.update(runActions).set({ state: "claimed", leaseOwner: input.supervisorId, leaseExpiresAt, attemptCount: action.attemptCount + 1, updatedAt: now }).where(eq(runActions.id, action.id)).run();
    const run = txContext.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, action.runId) }).sync();
    if (run?.state === "queued") {
      txContext.db.update(agentRuns).set({ state: "provisioning", updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
      appendRunEventInTransaction(txContext, { runId: run.id, attemptId: action.attemptId, type: "run.state_changed", data: { from: "queued", to: "provisioning" }, progress: true });
    }
    return txContext.db.query.runActions.findFirst({ where: eq(runActions.id, action.id) }).sync()!;
  });
}

export function heartbeatRunAction(context: ServiceContext, input: { actionId: string; supervisorId: string; leaseMs?: number }) {
  return inTransaction(context, (txContext) => {
    const action = requireClaimedAction(txContext, input.actionId, input.supervisorId);
    const now = txContext.clock.now();
    txContext.db.update(runActions).set({ leaseExpiresAt: new Date(now.getTime() + (input.leaseMs ?? 30_000)).toISOString(), updatedAt: now.toISOString() }).where(eq(runActions.id, action.id)).run();
    return txContext.db.query.runActions.findFirst({ where: eq(runActions.id, action.id) }).sync()!;
  });
}

export function completeRunAction(context: ServiceContext, input: { actionId: string; supervisorId: string; result: Record<string, unknown> }) {
  return inTransaction(context, (txContext) => {
    const existing = txContext.db.query.runActions.findFirst({ where: eq(runActions.id, input.actionId) }).sync();
    if (existing?.state === "completed") return existing;
    const action = requireClaimedAction(txContext, input.actionId, input.supervisorId);
    const now = txContext.clock.now().toISOString();
    txContext.db.update(runActions).set({ state: "completed", result: input.result, completedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(eq(runActions.id, action.id)).run();
    if (action.kind === "remove_raw_logs" || action.kind === "remove_worktree") {
      for (const artifactId of (action.payload as { artifactIds?: unknown[] }).artifactIds ?? []) {
        if (typeof artifactId === "string") txContext.db.update(runArtifacts).set({ removedAt: now }).where(eq(runArtifacts.id, artifactId)).run();
      }
    }
    if (action.kind === "publish_draft_pr" && typeof input.result.url === "string") {
      const run = txContext.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, action.runId) }).sync()!;
      txContext.db.insert(attachments).values({ id: uuid(), issueId: run.issueId, kind: "pr", title: `${run.id} draft pull request`, url: input.result.url, repoPath: null, remote: null, branchName: run.branch, commitSha: typeof input.result.commitSha === "string" ? input.result.commitSha : null, createdAt: now }).run();
      if (txContext.actor) txContext.db.insert(activity).values({ id: uuid(), issueId: run.issueId, actorId: txContext.actor.id, action: "run_pull_request_attached", data: { runId: run.id, url: input.result.url, branch: run.branch }, createdAt: now }).run();
      applyConfiguredIssueTransition(txContext, run, "issueReviewState", now);
    }
    appendRunEventInTransaction(txContext, { runId: action.runId, attemptId: action.attemptId, type: "action.completed", data: { actionId: action.id, kind: action.kind, result: input.result }, progress: true });
    reduceCompletedAction(txContext, action, input.result);
    return txContext.db.query.runActions.findFirst({ where: eq(runActions.id, action.id) }).sync()!;
  });
}

export function failRunAction(context: ServiceContext, input: { actionId: string; supervisorId: string; error: Record<string, unknown>; retryable?: boolean }) {
  return inTransaction(context, (txContext) => {
    const action = requireClaimedAction(txContext, input.actionId, input.supervisorId);
    const now = txContext.clock.now().toISOString();
    if (input.retryable) {
      txContext.db.update(runActions).set({ state: "queued", error: input.error, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(eq(runActions.id, action.id)).run();
      appendRunEventInTransaction(txContext, { runId: action.runId, attemptId: action.attemptId, type: "action.retry_queued", data: { actionId: action.id, kind: action.kind, error: input.error } });
    } else {
      txContext.db.update(runActions).set({ state: "failed", error: input.error, completedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(eq(runActions.id, action.id)).run();
      const run = getRun(txContext, action.runId);
      if (!["succeeded", "partial", "failed", "canceled", "crashed"].includes(run.state)) {
        const publicationFailure = action.kind === "push_branch" || action.kind === "publish_draft_pr";
        txContext.db.update(agentRuns).set({ state: publicationFailure ? "partial" : "failed", error: input.error, outcome: publicationFailure ? "publication_failed_verified_branch_preserved" : "action_failed", completedAt: now, updatedAt: now }).where(eq(agentRuns.id, action.runId)).run();
        txContext.db.update(runAttempts).set({ state: "failed", error: input.error, completedAt: now }).where(and(eq(runAttempts.runId, action.runId), eq(runAttempts.id, action.attemptId!))).run();
        appendRunEventInTransaction(txContext, { runId: action.runId, attemptId: action.attemptId, type: publicationFailure ? "run.partial" : "run.failed", data: { actionId: action.id, kind: action.kind, error: input.error, preserved: publicationFailure ? ["branch", "worktree", "verification"] : [] }, progress: true });
      }
    }
    return txContext.db.query.runActions.findFirst({ where: eq(runActions.id, action.id) }).sync()!;
  });
}

export function releaseExpiredRunActions(context: ServiceContext) {
  return inTransaction(context, (txContext) => {
    const now = txContext.clock.now().toISOString();
    const expired = txContext.db.query.runActions.findMany({ where: and(eq(runActions.state, "claimed"), lte(runActions.leaseExpiresAt, now)), orderBy: [asc(runActions.createdAt), asc(runActions.id)] }).sync();
    for (const action of expired) {
      txContext.db.update(runActions).set({ state: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(eq(runActions.id, action.id)).run();
      appendRunEventInTransaction(txContext, { runId: action.runId, attemptId: action.attemptId, type: "action.lease_expired", data: { actionId: action.id, kind: action.kind } });
    }
    return expired.length;
  });
}

function requireClaimedAction(context: ServiceContext, actionId: string, supervisorId: string) {
  const action = context.db.query.runActions.findFirst({ where: eq(runActions.id, actionId) }).sync();
  if (!action || action.state !== "claimed" || action.leaseOwner !== supervisorId) throw new AppError(AppErrorCode.RUN_ACTION_UNAVAILABLE, `Action ${actionId} is not leased by supervisor ${supervisorId}.`, { actionId, supervisorId });
  return action;
}

function reduceCompletedAction(context: ServiceContext, action: typeof runActions.$inferSelect, result: Record<string, unknown>) {
  const now = context.clock.now().toISOString();
  const run = context.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, action.runId) }).sync()!;
  if (action.kind === "provision_worktree") {
    context.db.update(agentRuns).set({ state: "running", startedAt: now, updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
    if (action.attemptId) context.db.update(runAttempts).set({ state: "running", startedAt: now }).where(eq(runAttempts.id, action.attemptId)).run();
    applyConfiguredIssueTransition(context, run, "issueStartedState", now);
    const setup = ((run.resolvedConfiguration as { repositories?: Array<{ commands?: { setup?: unknown } }> }).repositories?.[0]?.commands?.setup);
    if (setup) enqueue(context, action, "setup_command", { command: setup }, "setup");
    else enterPlan(context, action, run.id, now);
  } else if (action.kind === "setup_command") {
    enterPlan(context, action, run.id, now);
  } else if (action.kind === "run_participant" && result.role === "planner") {
    requireStructuredResult(result);
    const risk = (result.structuredResult as { risk?: unknown }).risk;
    if (risk === "medium" || risk === "high") {
      enqueue(context, action, "run_participant", { role: "adversarialReviewer", purpose: "plan_review", plan: result.structuredResult }, "opposing-plan-review");
      appendRunEventInTransaction(context, { runId: run.id, attemptId: action.attemptId, type: "plan.review_requested", data: { risk }, progress: true });
    } else {
      enterImplement(context, action, result.structuredResult as Record<string, unknown>, null, now);
    }
  } else if (action.kind === "run_participant" && (action.payload as { purpose?: unknown }).purpose === "plan_review") {
    requireStructuredResult(result);
    enterImplement(context, action, (action.payload as { plan: Record<string, unknown> }).plan, result.structuredResult as Record<string, unknown>, now);
  } else if (action.kind === "run_participant" && result.role === "implementer") {
    requireStructuredResult(result);
    context.db.update(agentRuns).set({ phase: "verify", updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
    enqueue(context, action, "verify_commands", { selfReport: result.structuredResult }, "verify");
    appendRunEventInTransaction(context, { runId: run.id, attemptId: action.attemptId, type: "phase.changed", data: { from: "implement", to: "verify" }, progress: true });
  } else if (action.kind === "verify_commands") {
    if (result.clean !== true) {
      context.db.update(agentRuns).set({ state: "blocked", outcome: "verification_not_clean", updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
      appendRunEventInTransaction(context, { runId: run.id, attemptId: action.attemptId, type: "verification.blocked", data: { results: result.results ?? [] }, progress: true });
      return;
    }
    context.db.update(agentRuns).set({ phase: "review", updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
    enqueue(context, action, "run_participant", { role: "bindingReviewer", verification: result }, `binding-review:${action.id}`);
    enqueue(context, action, "run_participant", { role: "adversarialReviewer", verification: result }, `adversarial-review:${action.id}`);
    appendRunEventInTransaction(context, { runId: run.id, attemptId: action.attemptId, type: "phase.changed", data: { from: "verify", to: "review" }, progress: true });
  } else if (action.kind === "run_participant" && (result.role === "bindingReviewer" || result.role === "adversarialReviewer")) {
    requireStructuredResult(result);
    const remaining = context.db.query.runActions.findMany({ where: and(eq(runActions.runId, run.id), eq(runActions.kind, "run_participant")) }).sync().filter((candidate) => candidate.id !== action.id && candidate.state !== "completed" && ["bindingReviewer", "adversarialReviewer"].includes((candidate.payload as { role?: string }).role ?? ""));
    if (remaining.length === 0) {
      const blockers = context.db.query.runReviewFindings.findMany({ where: and(eq(runReviewFindings.runId, run.id), eq(runReviewFindings.source, "binding"), eq(runReviewFindings.severity, "blocking")) }).sync().filter((finding) => !finding.resolution);
      const addressCount = context.db.query.runActions.findMany({ where: and(eq(runActions.runId, run.id), eq(runActions.kind, "run_participant")) }).sync().filter((candidate) => (candidate.payload as { addressFindingIds?: unknown }).addressFindingIds).length;
      const maxAddressCycles = (run.resolvedConfiguration as { profile?: { configuration?: { maxAddressCycles?: number } } }).profile?.configuration?.maxAddressCycles ?? 2;
      if (blockers.length > 0 && addressCount < maxAddressCycles) {
        context.db.update(agentRuns).set({ phase: "implement", updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
        enqueue(context, action, "run_participant", { role: "implementer", addressFindingIds: blockers.map((finding) => finding.id) }, `address:${addressCount + 1}`);
        appendRunEventInTransaction(context, { runId: run.id, attemptId: action.attemptId, type: "review.address_requested", data: { findingIds: blockers.map((finding) => finding.id), cycle: addressCount + 1 }, progress: true });
      } else if (blockers.length > 0) {
        context.db.update(agentRuns).set({ state: "partial", outcome: "review_address_limit_reached", completedAt: now, updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
        appendRunEventInTransaction(context, { runId: run.id, attemptId: action.attemptId, type: "run.partial", data: { outcome: "review_address_limit_reached", findingIds: blockers.map((finding) => finding.id) }, progress: true });
      } else {
        reconcileFindings(context, run.id);
        context.db.update(agentRuns).set({ phase: "finalize", updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
        enqueue(context, action, "finalize", {}, "finalize");
        appendRunEventInTransaction(context, { runId: run.id, attemptId: action.attemptId, type: "phase.changed", data: { from: "review", to: "finalize" }, progress: true });
      }
    }
  } else if (action.kind === "finalize") {
    const policies = (run.resolvedConfiguration as { policies?: { push?: string; draftPr?: string } }).policies;
    if (policies?.push === "automatic") enqueue(context, action, "push_branch", { branch: run.branch, publishDraftPr: policies.draftPr === "automatic" }, "push");
    else if (policies?.push === "never") completeFromEvidence(context, run.id, result, null);
    else appendRunEventInTransaction(context, { runId: run.id, attemptId: action.attemptId, type: "publication.awaiting_approval", data: { branch: run.branch, draftPrPolicy: policies?.draftPr ?? "approved" } });
  } else if (action.kind === "push_branch" && (action.payload as { publishDraftPr?: boolean }).publishDraftPr) {
    enqueue(context, action, "publish_draft_pr", { branch: run.branch, push: result }, "draft-pr");
  } else if (action.kind === "push_branch") {
    completeFromEvidence(context, run.id, finalizationResult(context, run.id), null);
  } else if (action.kind === "publish_draft_pr") {
    completeFromEvidence(context, run.id, finalizationResult(context, run.id), typeof result.url === "string" ? result.url : null);
  }
}

function reconcileFindings(context: ServiceContext, runId: string) {
  const findings = context.db.query.runReviewFindings.findMany({ where: eq(runReviewFindings.runId, runId), orderBy: [asc(runReviewFindings.createdAt), asc(runReviewFindings.id)] }).sync();
  for (const finding of findings) {
    const counterpart = findings.find((candidate) => candidate.id !== finding.id && candidate.source !== finding.source && candidate.file === finding.file && candidate.location === finding.location && candidate.severity === finding.severity);
    context.db.update(runReviewFindings).set({ reconciliation: counterpart ? "agreed" : finding.source === "binding" ? "binding_only" : "adversary_only" }).where(eq(runReviewFindings.id, finding.id)).run();
  }
  appendRunEventInTransaction(context, { runId, type: "review.reconciled", data: { total: findings.length }, progress: true });
}

function finalizationResult(context: ServiceContext, runId: string) {
  const finalize = context.db.query.runActions.findMany({ where: and(eq(runActions.runId, runId), eq(runActions.kind, "finalize")), orderBy: [asc(runActions.createdAt), asc(runActions.id)] }).sync().filter((candidate) => candidate.state === "completed").at(-1);
  if (!finalize?.result || typeof finalize.result !== "object") throw new AppError(AppErrorCode.DATA_INTEGRITY, "Completed finalization is missing its structured result.");
  return finalize.result as Record<string, unknown>;
}

function completeFromEvidence(context: ServiceContext, runId: string, finalized: Record<string, unknown>, pullRequestUrl: string | null) {
  const verification = context.db.query.runActions.findMany({ where: and(eq(runActions.runId, runId), eq(runActions.kind, "verify_commands")), orderBy: [asc(runActions.createdAt), asc(runActions.id)] }).sync().filter((candidate) => candidate.state === "completed").at(-1);
  const verificationResults = verification?.result && typeof verification.result === "object" && Array.isArray((verification.result as { results?: unknown }).results) ? (verification.result as { results: Array<{ command?: unknown; classification?: unknown }> }).results : [];
  const implementer = context.db.query.runActions.findMany({ where: and(eq(runActions.runId, runId), eq(runActions.kind, "run_participant")), orderBy: [asc(runActions.createdAt), asc(runActions.id)] }).sync().filter((candidate) => candidate.state === "completed" && (candidate.result as { role?: unknown } | null)?.role === "implementer").at(-1);
  const structured = implementer?.result && typeof implementer.result === "object" ? (implementer.result as { structuredResult?: Record<string, unknown> }).structuredResult : undefined;
  const riskNotes = Array.isArray(structured?.riskNotes) ? structured.riskNotes.filter((value): value is string => typeof value === "string") : Array.isArray(structured?.risks) ? structured.risks.filter((value): value is string => typeof value === "string") : [];
  completeRunWorkflowInTransaction(context, {
    run: runId,
    commitSha: String(finalized.commitSha),
    filesChanged: Array.isArray(finalized.filesChanged) ? finalized.filesChanged.filter((value): value is string => typeof value === "string") : [],
    diffSize: typeof finalized.diffSize === "number" ? finalized.diffSize : 0,
    testsRun: verificationResults.map((result) => String(result.command ?? "verification")),
    testsFailed: verificationResults.filter((result) => result.classification !== "clean").map((result) => String(result.command ?? "verification")),
    riskNotes,
    branch: String(finalized.branch),
    pullRequestUrl
  });
}

function enterImplement(context: ServiceContext, action: typeof runActions.$inferSelect, plan: Record<string, unknown>, planReview: Record<string, unknown> | null, now: string) {
  context.db.update(agentRuns).set({ phase: "implement", updatedAt: now }).where(eq(agentRuns.id, action.runId)).run();
  enqueue(context, action, "run_participant", { role: "implementer", plan, planReview }, "implementer");
  appendRunEventInTransaction(context, { runId: action.runId, attemptId: action.attemptId, type: "phase.changed", data: { from: "plan", to: "implement", opposingReview: planReview !== null }, progress: true });
}

function applyConfiguredIssueTransition(context: ServiceContext, run: typeof agentRuns.$inferSelect, key: "issueStartedState" | "issueReviewState", now: string) {
  const configured = (run.resolvedConfiguration as { profile?: { configuration?: Record<string, unknown> } }).profile?.configuration?.[key];
  if (typeof configured !== "string") return;
  const issue = context.db.query.issues.findFirst({ where: eq(issues.id, run.issueId) }).sync();
  if (!issue) return;
  const target = configured === "__started__"
    ? context.db.query.workflowStates.findFirst({ where: and(eq(workflowStates.teamId, issue.teamId), eq(workflowStates.type, "started")) }).sync()
    : context.db.query.workflowStates.findFirst({ where: and(eq(workflowStates.teamId, issue.teamId), eq(workflowStates.name, configured)) }).sync();
  if (!target || target.id === issue.stateId) return;
  context.db.update(issues).set({ stateId: target.id, updatedAt: now, ...(target.type === "started" && !issue.startedAt ? { startedAt: now } : {}) }).where(eq(issues.id, issue.id)).run();
  if (context.actor) context.db.insert(activity).values({ id: uuid(), issueId: issue.id, actorId: context.actor.id, action: "state_changed", data: { from: issue.stateId, to: target.id, runId: run.id }, createdAt: now }).run();
}

function enterPlan(context: ServiceContext, action: typeof runActions.$inferSelect, runId: string, now: string) {
  context.db.update(agentRuns).set({ phase: "plan", updatedAt: now }).where(eq(agentRuns.id, runId)).run();
  enqueue(context, action, "run_participant", { role: "planner" }, "planner");
  appendRunEventInTransaction(context, { runId, attemptId: action.attemptId, type: "phase.changed", data: { from: "preflight", to: "plan" }, progress: true });
}

function enqueue(context: ServiceContext, parent: typeof runActions.$inferSelect, kind: string, payload: Record<string, unknown>, suffix: string) {
  const now = context.clock.now().toISOString();
  context.db.insert(runActions).values({ id: uuid(), runId: parent.runId, attemptId: parent.attemptId, kind, idempotencyKey: `${parent.runId}:${parent.attemptId}:${suffix}`, payload, state: "queued", leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null }).onConflictDoNothing().run();
}

function requireStructuredResult(result: Record<string, unknown>) {
  if (!result.structuredResult || typeof result.structuredResult !== "object") throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "A clean process exit without the required structured result cannot advance the workflow.");
}
