import { and, eq, isNull, or } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { agentRuns, runActions, runAttempts, runInputRequests, runParticipants } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { appendRunEventInTransaction, getRun } from "./run.js";

const TERMINAL = ["succeeded", "partial", "failed", "canceled", "crashed"];

export function requestRunInput(context: ServiceContext, input: { run: string; participantId: string; kind: "input" | "permission"; prompt: string; operation?: Record<string, unknown> | null; blocking?: boolean; delivery?: "resume" | "hook"; providerSessionId?: string | null }) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    const participant = txContext.db.query.runParticipants.findFirst({ where: and(eq(runParticipants.id, input.participantId), eq(runParticipants.runId, input.run)) }).sync();
    if (!participant || !["running", "waiting"].includes(participant.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Input can only be requested by a live participant.");
    if (TERMINAL.includes(run.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "A terminal run cannot request input.");
    const now = txContext.clock.now().toISOString();
    const delivery = input.delivery ?? "resume";
    const request = { id: uuid(), runId: input.run, participantId: input.participantId, kind: input.kind, prompt: input.prompt, operation: input.operation ?? null, blocking: input.blocking ?? true, delivery, state: "pending" as const, response: null, requestedBy: participant.actor, respondedBy: null, requestedAt: now, respondedAt: null };
    txContext.db.insert(runInputRequests).values(request).run();
    // A hook-delivered request arrives mid-session, before the participant action completes and
    // records the session id. Stamp it now so resolution can verify liveness and so the resume
    // fallback has a session to reattach to if the bounded hook wait expires.
    const session = input.providerSessionId ?? participant.providerSessionId;
    txContext.db.update(runParticipants).set({ state: "waiting", providerSessionId: session }).where(eq(runParticipants.id, participant.id)).run();
    if (request.blocking) txContext.db.update(agentRuns).set({ state: "waiting_for_input", updatedAt: now }).where(eq(agentRuns.id, input.run)).run();
    appendRunEventInTransaction(txContext, { runId: input.run, attemptId: participant.attemptId, participantId: participant.id, type: input.kind === "permission" ? "permission.requested" : "input.requested", data: { requestId: request.id, prompt: request.prompt, blocking: request.blocking, delivery, operation: request.operation }, progress: true });
    return request;
  });
}

export function getRunInputRequest(context: ServiceContext, runId: string, requestId: string) {
  return context.db.query.runInputRequests.findFirst({ where: and(eq(runInputRequests.id, requestId), eq(runInputRequests.runId, runId)) }).sync() ?? null;
}

/**
 * Emits a progress event while a hook blocks on a human decision. Without this the run trips
 * `detectStalls`, because `permission.requested` marks progress only once and a human may
 * legitimately deliberate for longer than the stall threshold.
 */
export function recordPermissionWaitProgress(context: ServiceContext, runId: string, requestId: string) {
  return inTransaction(context, (txContext) => {
    const request = txContext.db.query.runInputRequests.findFirst({ where: and(eq(runInputRequests.id, requestId), eq(runInputRequests.runId, runId)) }).sync();
    if (!request || request.state !== "pending") return null;
    const participant = txContext.db.query.runParticipants.findFirst({ where: eq(runParticipants.id, request.participantId) }).sync();
    appendRunEventInTransaction(txContext, { runId, attemptId: participant?.attemptId ?? null, participantId: request.participantId, type: "permission.waiting", data: { requestId, waitingSince: request.requestedAt }, progress: true });
    return request;
  });
}

/**
 * Ends the provider-side blocking wait when the bounded hook timeout expires, converting the
 * still-pending request to resume delivery so a later approval reaches the provider by restarting
 * the session instead of by a hook that is no longer listening. Returns the request if it was
 * resolved in the meantime, so a decision racing the timeout is still honored inline.
 */
export function expireHookPermissionWait(context: ServiceContext, runId: string, requestId: string) {
  return inTransaction(context, (txContext) => {
    const request = txContext.db.query.runInputRequests.findFirst({ where: and(eq(runInputRequests.id, requestId), eq(runInputRequests.runId, runId)) }).sync();
    if (!request) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Run request ${requestId} was not found.`);
    if (request.state !== "pending") return request;
    txContext.db.update(runInputRequests).set({ delivery: "resume" }).where(eq(runInputRequests.id, requestId)).run();
    const participant = txContext.db.query.runParticipants.findFirst({ where: eq(runParticipants.id, request.participantId) }).sync();
    appendRunEventInTransaction(txContext, { runId, attemptId: participant?.attemptId ?? null, participantId: request.participantId, type: "permission.wait_expired", data: { requestId, delivery: "resume" }, progress: true });
    return null;
  });
}

export function respondToRunInput(context: ServiceContext, input: { run: string; request: string; response: string }) {
  return resolveRequest(context, input.run, input.request, "answered", input.response);
}

export function resolveRunPermission(context: ServiceContext, input: { run: string; request: string; decision: "approved" | "denied" }) {
  return resolveRequest(context, input.run, input.request, input.decision, input.decision);
}

function resolveRequest(context: ServiceContext, runId: string, requestId: string, state: "answered" | "approved" | "denied", response: string) {
  if (!context.actor) throw new AppError(AppErrorCode.ACTOR_NOT_FOUND, "Responding to a run requires an actor.");
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, runId);
    if (TERMINAL.includes(run.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "A terminal run cannot accept input.");
    const request = txContext.db.query.runInputRequests.findFirst({ where: and(eq(runInputRequests.id, requestId), eq(runInputRequests.runId, runId)) }).sync();
    if (!request) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Run request ${requestId} was not found.`);
    if (request.state !== "pending") {
      if (request.state === state && request.response === response) return request;
      throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Run request ${requestId} has already been resolved.`);
    }
    const participant = txContext.db.query.runParticipants.findFirst({ where: eq(runParticipants.id, request.participantId) }).sync();
    if (!participant || !["running", "waiting"].includes(participant.state) || !participant.providerSessionId) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "The target participant is no longer live; input was not delivered.");
    const now = txContext.clock.now().toISOString();
    txContext.db.update(runInputRequests).set({ state, response, respondedBy: txContext.actor!.id, respondedAt: now }).where(eq(runInputRequests.id, request.id)).run();
    // Hook delivery reaches a provider process that is still alive and polling this row, so the
    // decision needs no transport. Enqueueing deliver_input here would start a second --resume
    // subprocess and orphan the blocked one.
    if (request.delivery === "resume") {
      txContext.db.insert(runActions).values({ id: uuid(), runId, attemptId: participant.attemptId, kind: "deliver_input", idempotencyKey: `${runId}:request:${request.id}`, payload: { requestId: request.id, participantId: participant.id, providerSessionId: participant.providerSessionId, state, response }, state: "queued", leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null }).run();
    }
    const pendingBlocking = txContext.db.query.runInputRequests.findMany({ where: and(eq(runInputRequests.runId, runId), eq(runInputRequests.state, "pending"), eq(runInputRequests.blocking, true)) }).sync().filter((candidate) => candidate.id !== request.id);
    if (pendingBlocking.length === 0) {
      txContext.db.update(agentRuns).set({ state: "running", updatedAt: now }).where(and(eq(agentRuns.id, runId), eq(agentRuns.state, "waiting_for_input"))).run();
      txContext.db.update(runParticipants).set({ state: "running" }).where(and(eq(runParticipants.id, participant.id), eq(runParticipants.state, "waiting"))).run();
    }
    appendRunEventInTransaction(txContext, { runId, attemptId: participant.attemptId, participantId: participant.id, type: request.kind === "permission" ? "permission.resolved" : "input.responded", data: { requestId: request.id, state, actorId: txContext.actor!.id }, progress: true });
    return txContext.db.query.runInputRequests.findFirst({ where: eq(runInputRequests.id, request.id) }).sync()!;
  });
}

export function requestRunStop(context: ServiceContext, runId: string, force = false) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, runId);
    if (TERMINAL.includes(run.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "A terminal run cannot be stopped again.");
    const now = txContext.clock.now().toISOString();
    txContext.db.insert(runActions).values({ id: uuid(), runId, attemptId: run.attempts.find((attempt) => !attempt.completedAt)?.id ?? null, kind: force ? "force_stop" : "graceful_stop", idempotencyKey: `${runId}:stop:${force ? "force" : "graceful"}`, payload: { force }, state: "queued", leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null }).onConflictDoNothing().run();
    appendRunEventInTransaction(txContext, { runId, type: "run.stop_requested", data: { force, actorId: txContext.actor?.id ?? null } });
    return getRun(txContext, runId);
  });
}

export function confirmRunStopped(context: ServiceContext, runId: string) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, runId);
    if (TERMINAL.includes(run.state)) return run;
    const now = txContext.clock.now().toISOString();
    txContext.db.update(agentRuns).set({ state: "canceled", outcome: "stopped", completedAt: now, updatedAt: now }).where(eq(agentRuns.id, runId)).run();
    txContext.db.update(runAttempts).set({ state: "canceled", completedAt: now }).where(and(eq(runAttempts.runId, runId), eq(runAttempts.state, "running"))).run();
    txContext.db.update(runParticipants).set({ state: "stopped", completedAt: now }).where(and(eq(runParticipants.runId, runId), or(eq(runParticipants.state, "running"), eq(runParticipants.state, "waiting")))).run();
    txContext.db.update(runInputRequests).set({ state: "expired", respondedAt: now }).where(and(eq(runInputRequests.runId, runId), eq(runInputRequests.state, "pending"))).run();
    txContext.db.update(runActions).set({ state: "canceled", error: { reason: "run_canceled" }, completedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(and(eq(runActions.runId, runId), or(eq(runActions.state, "queued"), eq(runActions.state, "claimed")))).run();
    appendRunEventInTransaction(txContext, { runId, type: "run.canceled", data: { preserved: ["branch", "worktree", "logs"] }, progress: true });
    return getRun(txContext, runId);
  });
}

export function markRunStalled(context: ServiceContext, runId: string) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, runId);
    if (run.state !== "running") throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Only a running run can be marked stalled.");
    txContext.db.update(agentRuns).set({ state: "stalled", updatedAt: txContext.clock.now().toISOString() }).where(eq(agentRuns.id, runId)).run();
    appendRunEventInTransaction(txContext, { runId, type: "run.stalled", data: { lastEventAt: run.lastEventAt, lastProgressAt: run.lastProgressAt } });
    return getRun(txContext, runId);
  });
}

export function retryRun(context: ServiceContext, input: { run: string; engine?: string; reason?: string }) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    if (!['blocked', 'stalled'].includes(run.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Retry is available only for a blocked or stalled active run; terminal history is immutable.");
    const active = run.attempts.find((attempt) => !attempt.completedAt);
    const now = txContext.clock.now().toISOString();
    if (active) txContext.db.update(runAttempts).set({ state: "failed", completedAt: now, error: { reason: "retry" } }).where(eq(runAttempts.id, active.id)).run();
    if (active) txContext.db.update(runParticipants).set({ state: "stopped", completedAt: now }).where(and(eq(runParticipants.attemptId, active.id), isNull(runParticipants.completedAt))).run();
    if (active) txContext.db.update(runInputRequests).set({ state: "expired", respondedAt: now }).where(and(eq(runInputRequests.runId, run.id), eq(runInputRequests.state, "pending"))).run();
    if (active) txContext.db.update(runActions).set({ state: "canceled", error: { reason: "attempt_retried" }, completedAt: now, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(and(eq(runActions.attemptId, active.id), or(eq(runActions.state, "queued"), eq(runActions.state, "claimed")))).run();
    const number = run.attemptCounter + 1;
    const attemptId = uuid();
    txContext.db.insert(runAttempts).values({ id: attemptId, runId: run.id, number, reason: input.reason ?? "retry", requestedEngine: { engine: input.engine ?? null }, actualEngine: null, state: "queued", startedAt: null, completedAt: null, result: null, error: null, createdAt: now }).run();
    txContext.db.update(agentRuns).set({ state: "running", phase: "implement", attemptCounter: number, updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
    txContext.db.insert(runActions).values({ id: uuid(), runId: run.id, attemptId, kind: "run_participant", idempotencyKey: `${run.id}:${attemptId}:retry`, payload: { role: "implementer", engine: input.engine ?? null }, state: "queued", leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null }).run();
    appendRunEventInTransaction(txContext, { runId: run.id, attemptId, type: "attempt.created", data: { number, reason: input.reason ?? "retry", engine: input.engine ?? null }, progress: true });
    return getRun(txContext, run.id);
  });
}

export function startFallbackAttempt(context: ServiceContext, input: { run: string; engine: string; reason?: string }) {
  return retryRun(context, { ...input, reason: input.reason ?? "fallback" });
}

export function resumeRun(context: ServiceContext, runId: string) {
  return enqueueParticipantControl(context, runId, "resume_participant");
}

export function nudgeRun(context: ServiceContext, runId: string, message: string) {
  return enqueueParticipantControl(context, runId, "nudge_participant", message);
}

function enqueueParticipantControl(context: ServiceContext, runId: string, kind: "resume_participant" | "nudge_participant", message?: string) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, runId);
    if (!["stalled", "blocked"].includes(run.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, `${kind === "resume_participant" ? "Resume" : "Nudge"} requires a stalled or blocked active run.`);
    const participant = run.participants.find((candidate) => candidate.providerSessionId && ["running", "waiting"].includes(candidate.state));
    const capabilities = participant?.capabilities as { resume?: unknown; redirect?: unknown } | undefined;
    const supported = kind === "resume_participant" ? capabilities?.resume === true : capabilities?.redirect === true;
    if (!participant || !supported) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, `The live participant does not declare ${kind === "resume_participant" ? "resume" : "redirect"} capability; create a retry attempt instead.`);
    const now = txContext.clock.now().toISOString();
    txContext.db.insert(runActions).values({ id: uuid(), runId, attemptId: participant.attemptId, kind, idempotencyKey: `${runId}:${participant.id}:${kind}:${run.eventCounter + 1}`, payload: { participantId: participant.id, providerSessionId: participant.providerSessionId, message: message ?? null }, state: "queued", leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null }).run();
    txContext.db.update(agentRuns).set({ state: "running", updatedAt: now }).where(eq(agentRuns.id, runId)).run();
    appendRunEventInTransaction(txContext, { runId, attemptId: participant.attemptId, participantId: participant.id, type: kind === "resume_participant" ? "run.resume_requested" : "run.nudge_requested", data: { providerSessionId: participant.providerSessionId, message: message ?? null }, progress: true });
    return getRun(txContext, runId);
  });
}
