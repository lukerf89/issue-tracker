import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import {
  activity, agentRuns, runActions, runArtifacts, runAttempts, runEvents, runParticipants,
  runInputRequests, runRepositories, runReviewFindings, runVerifications, type AgentRun
} from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { profileConfigurationSchema } from "../schemas/profile.js";
import { engineDefinitionSchema, type EngineCatalog, type EngineDefinition } from "../schemas/engine.js";
import { type PreviewRunInput, type RunPhase, type RunState, type StartRunInput } from "../schemas/run.js";
import { getIssue } from "./issue.js";
import { getProfile } from "./profile.js";
import { engineHealthFingerprint, engineHealthProblem, getEngineHealth } from "./engine-health.js";
import { resolveIssueRepositories, type RepositoryInspector } from "./repository.js";

const TERMINAL_STATES = new Set<RunState>(["succeeded", "partial", "failed", "canceled", "crashed"]);
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["provisioning", "canceled", "failed"], provisioning: ["running", "failed", "canceled", "crashed"],
  running: ["waiting_for_input", "blocked", "stalled", "succeeded", "partial", "failed", "canceled", "crashed"],
  waiting_for_input: ["running", "blocked", "failed", "canceled", "crashed"],
  blocked: ["running", "partial", "failed", "canceled"], stalled: ["running", "failed", "canceled", "crashed"],
  succeeded: [], partial: [], failed: [], canceled: [], crashed: []
};

export interface RunResolutionRuntime {
  inspector: RepositoryInspector;
  dataRoot: string;
  engineCatalog?: EngineCatalog;
  executableAvailable?: (executable: string) => boolean;
  fingerprintIssuedAt?: string;
  requireEngineHealth?: boolean;
  engineHealthTtlMs?: number;
}

export function previewRun(context: ServiceContext, input: PreviewRunInput, runtime: RunResolutionRuntime) {
  const issue = getIssue(context, input.issue);
  const profile = getProfile(context, input.profile);
  if (profile.archivedAt) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Profile ${profile.name} is archived.`);
  const repositories = resolveIssueRepositories(context, issue.identifier);
  if (repositories.length === 0) throw new AppError(AppErrorCode.REPOSITORY_NOT_FOUND, `Issue ${issue.identifier} has no resolved repository.`);
  const priorRunCount = context.db.query.agentRuns.findMany({ where: eq(agentRuns.issueId, issue.id) }).sync().length;
  const runSeed = stableHash({ issueId: issue.id, ordinal: priorRunCount + 1, parallelGroup: input.parallelGroup ?? null }).slice(0, 12);
  const resolvedRepositories = repositories.map((repository, position) => {
    const baseRef = input.baseRef ?? repository.defaultBranch;
    const inspection = runtime.inspector.inspect(repository.canonicalPath, baseRef);
    return {
      id: repository.id, name: repository.name, path: repository.canonicalPath, position,
      baseRef, baseCommit: inspection.headCommit, dirty: inspection.dirty,
      instructionFiles: inspection.instructionFiles,
      instructions: inspection.instructions,
      worktreePath: resolve(runtime.dataRoot, "worktrees", runSeed, repository.name),
      branch: `agent/${issue.identifier.toLowerCase()}-${runSeed}`,
      primary: position === 0,
      commands: { setup: repository.setupCommand, test: repository.testCommand, verification: repository.verificationCommand }
    };
  });
  const warnings = [
    ...(resolvedRepositories.length > 1 ? ["multi_repository"] : []),
    ...(resolvedRepositories.some((repository) => repository.dirty) ? ["dirty_checkout"] : [])
  ];
  type RoleAssignment = { engineName: string; adapter: string; executable: string | null; requestedModel: string; actualModel: string | null; options: EngineDefinition | null; healthFingerprint: string | null; capabilities: Record<string, unknown>; validationErrors: string[] };
  const roleAssignments: Record<string, RoleAssignment> = Object.fromEntries(Object.entries(profile.configuration.roles).sort(([left], [right]) => left.localeCompare(right)).map(([role, engineName]): [string, RoleAssignment] => {
    const definition = runtime.engineCatalog?.engines[engineName];
    if (!definition) return [role, { engineName, adapter: "unresolved", executable: null, requestedModel: engineName, actualModel: null, options: null, healthFingerprint: null, capabilities: {}, validationErrors: [] }];
    const effective = { ...definition, permissionMode: profile.configuration.permissionPolicy === "worktree-autonomous" ? "autonomous" as const : "prompt" as const };
    const validated = engineDefinitionSchema.safeParse(effective);
    return [role, { engineName, adapter: definition.adapter, executable: definition.executable, requestedModel: definition.model, actualModel: null, options: effective, healthFingerprint: engineHealthFingerprint(engineName, definition), capabilities: definition.capabilities, validationErrors: validated.success ? [] : validated.error.issues.map((issue) => issue.message) }];
  }));
  // Roles frequently share one engine, so an engine-level fault would otherwise repeat once per
  // role. Report each distinct message once and name the affected roles instead.
  const roleErrors = Object.entries(roleAssignments).flatMap(([role, assignment]): Array<{ role: string; message: string }> => {
    const messages = (() => {
      if (runtime.engineCatalog && assignment.adapter === "unresolved") return [`Engine ${assignment.engineName} is not configured.`];
      if (assignment.executable && runtime.executableAvailable && !runtime.executableAvailable(assignment.executable)) return [`Executable ${assignment.executable} for engine ${assignment.engineName} is unavailable.`];
      if (runtime.requireEngineHealth && assignment.options) {
        const fingerprint = assignment.healthFingerprint!;
        const problem = engineHealthProblem(getEngineHealth(context, assignment.engineName, fingerprint), context.clock.now(), runtime.engineHealthTtlMs ?? 15 * 60_000);
        if (problem) return [`${problem.code}: Engine ${assignment.engineName}: ${problem.message} ${problem.remediation}`];
      }
      return assignment.validationErrors.map((message) => `Engine ${assignment.engineName}: ${message}`);
    })();
    return messages.map((message) => ({ role, message }));
  });
  const errorRoles = new Map<string, string[]>();
  for (const { role, message } of roleErrors) errorRoles.set(message, [...errorRoles.get(message) ?? [], role]);
  const errors = [...errorRoles].map(([message, roles]) => roles.length > 1 ? `${message} Affected roles: ${[...roles].sort().join(", ")}.` : message);
  if (profile.configuration.reviewDepth === "full" && profile.configuration.roles.implementer === profile.configuration.roles.adversarialReviewer) errors.push("Full review depth requires an adversarial reviewer engine distinct from the implementer engine.");
  if (profile.configuration.draftPrPolicy === "automatic" && profile.configuration.pushPolicy !== "automatic") errors.push("Automatic draft pull-request publication requires automatic push policy.");
  const previewIssuedAt = runtime.fingerprintIssuedAt ?? context.clock.now().toISOString();
  const snapshot = {
    schemaVersion: 1, workflow: profile.workflow, workflowVersion: 1,
    issue: { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description },
    profile: { id: profile.id, name: profile.name, configuration: profileConfigurationSchema.parse(profile.configuration) },
    roleAssignments,
    repositories: resolvedRepositories,
    parallelGroup: input.parallelGroup ?? null,
    overrides: input.overrides ?? {},
    policies: {
      permission: profile.configuration.permissionPolicy, isolation: profile.configuration.isolation,
      fallback: profile.configuration.fallbackPolicy, push: profile.configuration.pushPolicy,
      draftPr: profile.configuration.draftPrPolicy, merge: "human" as const
    },
    warnings,
    errors,
    previewIssuedAt
  };
  return { ...snapshot, previewFingerprint: `${previewIssuedAt}.${stableHash(snapshot)}` };
}

export function startRun(context: ServiceContext, input: StartRunInput, runtime: RunResolutionRuntime) {
  const separator = input.previewFingerprint.indexOf(".", input.previewFingerprint.indexOf(".") + 1);
  const issuedAt = separator > 0 ? input.previewFingerprint.slice(0, separator) : "";
  const issuedTime = Date.parse(issuedAt);
  if (!Number.isFinite(issuedTime) || context.clock.now().getTime() - issuedTime > 5 * 60_000 || issuedTime - context.clock.now().getTime() > 5_000) throw new AppError(AppErrorCode.RUN_PREVIEW_STALE, "Run preview has expired; preview again before starting.");
  const preview = previewRun(context, input, { ...runtime, fingerprintIssuedAt: issuedAt });
  if (preview.previewFingerprint !== input.previewFingerprint) {
    throw new AppError(AppErrorCode.RUN_PREVIEW_STALE, "Run preview is stale; preview again before starting.", { expected: preview.previewFingerprint, received: input.previewFingerprint });
  }
  if (preview.errors.length) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Run preflight failed.", { errors: preview.errors });
  const missingConfirmations = preview.warnings.filter((warning) => !input.confirmWarnings.includes(warning));
  if (missingConfirmations.length) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "Run warnings require explicit confirmation.", { warnings: missingConfirmations });
  if (!context.actor) throw new AppError(AppErrorCode.ACTOR_NOT_FOUND, "Starting a run requires an actor.");
  return inTransaction(context, (txContext) => {
    const active = txContext.db.query.agentRuns.findMany({ where: and(eq(agentRuns.issueId, preview.issue.id), isNull(agentRuns.completedAt)) }).sync();
    if (!preview.parallelGroup && active.some((candidate) => candidate.parallelGroup === null)) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Issue ${preview.issue.identifier} already has an active run.`, { runId: active.find((candidate) => candidate.parallelGroup === null)?.id });
    if (preview.parallelGroup && active.some((candidate) => candidate.parallelGroup === preview.parallelGroup)) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Parallel group ${preview.parallelGroup} is already active for ${preview.issue.identifier}.`, { parallelGroup: preview.parallelGroup });
    const now = txContext.clock.now().toISOString();
    const runId = uuid();
    const attemptId = uuid();
    const primary = preview.repositories[0]!;
    const row = {
      id: runId, issueId: preview.issue.id, profileId: preview.profile.id, workflow: preview.workflow,
      workflowVersion: preview.workflowVersion, schemaVersion: preview.schemaVersion,
      resolvedConfiguration: preview, phase: "preflight" as const, state: "queued" as const,
      primaryRepositoryId: primary.id, baseRef: primary.baseRef, baseCommit: primary.baseCommit,
      branch: primary.branch, worktreePath: primary.worktreePath, parallelGroup: preview.parallelGroup,
      eventCounter: 1, attemptCounter: 1, startedAt: null, lastEventAt: now, lastProgressAt: now,
      completedAt: null, outcome: null, error: null, archivedAt: null, createdAt: now, updatedAt: now
    };
    txContext.db.insert(agentRuns).values(row).run();
    for (const repository of preview.repositories) txContext.db.insert(runRepositories).values({
      runId, repositoryId: repository.id, position: repository.position, baseRef: repository.baseRef,
      baseCommit: repository.baseCommit, worktreePath: repository.worktreePath, branch: repository.branch, isPrimary: repository.primary
    }).run();
    txContext.db.insert(runAttempts).values({ id: attemptId, runId, number: 1, reason: "initial", requestedEngine: { roles: preview.profile.configuration.roles }, actualEngine: null, state: "queued", startedAt: null, completedAt: null, result: null, error: null, createdAt: now }).run();
    const roles = Object.entries(preview.profile.configuration.roles).sort(([left], [right]) => left.localeCompare(right));
    for (const [role, engine] of roles) {
      const assignment = preview.roleAssignments[role]!;
      txContext.db.insert(runParticipants).values({
      id: uuid(), runId, attemptId, actor: engine, role, adapter: assignment.adapter, requestedModel: assignment.requestedModel,
      actualModel: null, providerSessionId: null, capabilities: assignment.capabilities, processIdentity: null, state: "queued",
      startedAt: null, lastHeartbeatAt: null, completedAt: null
    }).run(); }
    txContext.db.insert(runEvents).values({ id: uuid(), runId, sequence: 1, attemptId, participantId: null, type: "run.created", schemaVersion: 1, data: { issue: preview.issue.identifier, profile: preview.profile.name }, providerEventId: null, createdAt: now }).run();
    txContext.db.insert(runActions).values({ id: uuid(), runId, attemptId, kind: "provision_worktree", idempotencyKey: `${runId}:provision`, payload: { repositories: preview.repositories }, state: "queued", leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null }).run();
    txContext.db.insert(activity).values({ id: uuid(), issueId: preview.issue.id, actorId: txContext.actor!.id, action: "run_launched", data: { runId, profile: preview.profile.name }, createdAt: now }).run();
    return getRun(txContext, runId);
  });
}

export function getRun(context: ServiceContext, runId: string) {
  const run = context.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, runId) }).sync();
  if (!run) throw new AppError(AppErrorCode.RUN_NOT_FOUND, `Run ${runId} was not found.`, { run: runId });
  return hydrateRun(context, run);
}

export function listRuns(context: ServiceContext, options: { issue?: string; state?: RunState; includeArchived?: boolean } = {}) {
  let issueId: string | undefined;
  if (options.issue) issueId = getIssue(context, options.issue).id;
  const clauses = [options.includeArchived ? undefined : isNull(agentRuns.archivedAt), issueId ? eq(agentRuns.issueId, issueId) : undefined, options.state ? eq(agentRuns.state, options.state) : undefined].filter(Boolean) as ReturnType<typeof eq>[];
  return context.db.query.agentRuns.findMany({ where: clauses.length ? and(...clauses) : undefined, orderBy: [desc(agentRuns.createdAt), desc(agentRuns.id)] }).sync().map((run) => hydrateRun(context, run));
}

export function listRunEvents(context: ServiceContext, input: { run: string; after?: number; limit?: number }) {
  getRun(context, input.run);
  const events = context.db.query.runEvents.findMany({ where: and(eq(runEvents.runId, input.run), gt(runEvents.sequence, input.after ?? 0)), orderBy: [asc(runEvents.sequence)], limit: input.limit ?? 100 }).sync();
  return { events, nextCursor: events.at(-1)?.sequence ?? input.after ?? 0 };
}

export function appendRunEvent(context: ServiceContext, input: { runId: string; attemptId?: string | null; participantId?: string | null; type: string; data: Record<string, unknown>; providerEventId?: string | null; progress?: boolean }) {
  return inTransaction(context, (txContext) => appendRunEventInTransaction(txContext, input));
}

export function appendRunEventInTransaction(context: ServiceContext, input: { runId: string; attemptId?: string | null; participantId?: string | null; type: string; data: Record<string, unknown>; providerEventId?: string | null; progress?: boolean }) {
  const run = context.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, input.runId) }).sync();
  if (!run) throw new AppError(AppErrorCode.RUN_NOT_FOUND, `Run ${input.runId} was not found.`);
  if (input.providerEventId && input.participantId) {
    const existing = context.db.query.runEvents.findFirst({ where: and(eq(runEvents.participantId, input.participantId), eq(runEvents.providerEventId, input.providerEventId)) }).sync();
    if (existing) return existing;
  }
  const now = context.clock.now().toISOString();
  const sequence = run.eventCounter + 1;
  const event = { id: uuid(), runId: input.runId, sequence, attemptId: input.attemptId ?? null, participantId: input.participantId ?? null, type: input.type, schemaVersion: 1, data: input.data, providerEventId: input.providerEventId ?? null, createdAt: now };
  context.db.update(agentRuns).set({ eventCounter: sequence, lastEventAt: now, ...(input.progress ? { lastProgressAt: now } : {}), updatedAt: now }).where(eq(agentRuns.id, run.id)).run();
  context.db.insert(runEvents).values(event).run();
  const activityAction = breadcrumbAction(input.type, input.data);
  if (activityAction && context.actor) context.db.insert(activity).values({ id: uuid(), issueId: run.issueId, actorId: context.actor.id, action: activityAction, data: { runId: run.id, eventType: input.type, ...input.data }, createdAt: now }).run();
  return event;
}

export function transitionRun(context: ServiceContext, input: { run: string; expectedState: RunState; state: RunState; phase?: RunPhase; outcome?: string | null; error?: Record<string, unknown> | null; eventType?: string; eventData?: Record<string, unknown> }) {
  if (TERMINAL_STATES.has(input.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, "Terminal run states are reachable only through evidence-gated lifecycle operations.");
  return inTransaction(context, (txContext) => {
    const current = txContext.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, input.run) }).sync();
    if (!current) throw new AppError(AppErrorCode.RUN_NOT_FOUND, `Run ${input.run} was not found.`);
    if (current.state !== input.expectedState || !TRANSITIONS[current.state].includes(input.state)) throw new AppError(AppErrorCode.RUN_TRANSITION_INVALID, `Cannot transition run from ${current.state} to ${input.state}.`, { expectedState: input.expectedState, actualState: current.state, targetState: input.state });
    const now = txContext.clock.now().toISOString();
    txContext.db.update(agentRuns).set({ state: input.state, phase: input.phase ?? current.phase, outcome: input.outcome ?? current.outcome, error: input.error ?? current.error, startedAt: current.startedAt ?? (input.state === "running" ? now : null), completedAt: TERMINAL_STATES.has(input.state) ? now : null, updatedAt: now }).where(eq(agentRuns.id, current.id)).run();
    appendRunEventInTransaction(txContext, { runId: current.id, type: input.eventType ?? "run.state_changed", data: input.eventData ?? { from: current.state, to: input.state, phase: input.phase ?? current.phase }, progress: true });
    return getRun(txContext, current.id);
  });
}

export function recordArtifact(context: ServiceContext, input: { run: string; attemptId?: string | null; kind: string; title: string; localPath?: string | null; url?: string | null; sha256?: string | null; metadata?: Record<string, unknown> }) {
  return inTransaction(context, (txContext) => {
    getRun(txContext, input.run);
    const artifact = { id: uuid(), runId: input.run, attemptId: input.attemptId ?? null, kind: input.kind, title: input.title, localPath: input.localPath ?? null, url: input.url ?? null, sha256: input.sha256 ?? null, metadata: input.metadata ?? {}, attachmentId: null, removedAt: null, createdAt: txContext.clock.now().toISOString() };
    txContext.db.insert(runArtifacts).values(artifact).run();
    appendRunEventInTransaction(txContext, { runId: input.run, attemptId: input.attemptId, type: "artifact.recorded", data: { artifactId: artifact.id, kind: artifact.kind, title: artifact.title } });
    return artifact;
  });
}

export function archiveRun(context: ServiceContext, runId: string) {
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, runId);
    if (!TERMINAL_STATES.has(run.state)) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "Only terminal runs can be archived.");
    txContext.db.update(agentRuns).set({ archivedAt: txContext.clock.now().toISOString(), updatedAt: txContext.clock.now().toISOString() }).where(eq(agentRuns.id, runId)).run();
    return getRun(txContext, runId);
  });
}

function hydrateRun(context: ServiceContext, run: AgentRun) {
  if (!run.resolvedConfiguration || typeof run.resolvedConfiguration !== "object" || Array.isArray(run.resolvedConfiguration)) throw new AppError(AppErrorCode.DATA_INTEGRITY, `Stored run ${run.id} has an invalid resolved configuration.`);
  return {
    ...run,
    resolvedConfiguration: run.resolvedConfiguration,
    repositories: context.db.query.runRepositories.findMany({ where: eq(runRepositories.runId, run.id), orderBy: [asc(runRepositories.position), asc(runRepositories.repositoryId)] }).sync(),
    attempts: context.db.query.runAttempts.findMany({ where: eq(runAttempts.runId, run.id), orderBy: [asc(runAttempts.number)] }).sync(),
    participants: context.db.query.runParticipants.findMany({ where: eq(runParticipants.runId, run.id), orderBy: [asc(runParticipants.role), asc(runParticipants.id)] }).sync(),
    artifacts: context.db.query.runArtifacts.findMany({ where: eq(runArtifacts.runId, run.id), orderBy: [asc(runArtifacts.createdAt), asc(runArtifacts.id)] }).sync(),
    inputRequests: context.db.query.runInputRequests.findMany({ where: eq(runInputRequests.runId, run.id), orderBy: [asc(runInputRequests.requestedAt), asc(runInputRequests.id)] }).sync(),
    verifications: context.db.query.runVerifications.findMany({ where: eq(runVerifications.runId, run.id), orderBy: [asc(runVerifications.completedAt), asc(runVerifications.id)] }).sync(),
    reviewFindings: context.db.query.runReviewFindings.findMany({ where: eq(runReviewFindings.runId, run.id), orderBy: [asc(runReviewFindings.createdAt), asc(runReviewFindings.id)] }).sync(),
    pendingActions: context.db.query.runActions.findMany({ where: and(eq(runActions.runId, run.id), isNull(runActions.completedAt)), orderBy: [asc(runActions.createdAt), asc(runActions.id)] }).sync()
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function breadcrumbAction(type: string, data: Record<string, unknown>) {
  if (type === "phase.changed") return "run_phase_changed";
  if (type === "input.requested" || type === "permission.requested") return "run_waiting_for_input";
  if (type === "verification.completed") return "run_verification_completed";
  if (type === "review.finding" && data.severity === "blocking") return "run_review_blocked";
  if (type === "attempt.created" && data.reason === "fallback") return "run_engine_fallback";
  if (["run.failed", "run.partial", "run.canceled", "run.crashed", "run.stalled"].includes(type)) return type.replace(".", "_");
  return null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
