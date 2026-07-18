import { z } from "zod";

import { engineDefinitionSchema } from "./engine.js";
import { orchestrationRoleSchema, profileConfigurationSchema } from "./profile.js";
import { commandSpecSchema } from "./repository.js";
import { participantResultSchema, runPhaseSchema, runStateSchema, verificationClassificationSchema } from "./run.js";

const timestamp = z.string().datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();
const nullableString = z.string().nullable();
const jsonRecord = z.record(z.string(), z.unknown());
const capabilitySnapshotSchema = z.strictObject({
  resume: z.boolean().optional(), redirect: z.boolean().optional(), interactivePermissions: z.boolean().optional(),
  structuredOutput: z.boolean().optional(), childParticipants: z.boolean().optional(), usage: z.boolean().optional()
});

export const repositorySnapshotSchema = z.strictObject({
  id: z.string().min(1), name: z.string().min(1), canonicalPath: z.string().min(1), commonDir: z.string().min(1),
  defaultBranch: z.string().min(1), remote: nullableString, setupCommand: commandSpecSchema.nullable(),
  testCommand: commandSpecSchema, verificationCommand: commandSpecSchema, archivedAt: nullableTimestamp,
  createdAt: timestamp, updatedAt: timestamp
});

export const projectRepositorySnapshotSchema = z.strictObject({
  projectId: z.string().min(1), repositoryId: z.string().min(1), position: z.number().int().nonnegative(), isDefault: z.boolean()
});

export const issueRepositorySnapshotSchema = z.strictObject({
  issueId: z.string().min(1), repositoryId: z.string().min(1), position: z.number().int().nonnegative(), overrideKind: z.enum(["replace", "additional"])
});

export const orchestrationProfileSnapshotSchema = z.strictObject({
  id: z.string().min(1), name: z.string().min(1), workflow: z.string().min(1), schemaVersion: z.number().int().positive(),
  configuration: profileConfigurationSchema, isDefault: z.boolean(), isBuiltin: z.boolean(), archivedAt: nullableTimestamp,
  createdAt: timestamp, updatedAt: timestamp
});

const resolvedRepositorySchema = z.strictObject({
  id: z.string().min(1), name: z.string().min(1), path: z.string().min(1), position: z.number().int().nonnegative(),
  baseRef: z.string().min(1), baseCommit: z.string().min(1), dirty: z.boolean(), instructionFiles: z.array(z.string()),
  instructions: z.record(z.string(), z.string()), worktreePath: z.string().min(1), branch: z.string().min(1), primary: z.boolean(),
  commands: z.strictObject({ setup: commandSpecSchema.nullable(), test: commandSpecSchema, verification: commandSpecSchema })
});

export const resolvedRunConfigurationSnapshotSchema = z.strictObject({
  schemaVersion: z.number().int().positive(), workflow: z.string().min(1), workflowVersion: z.number().int().positive(),
  issue: z.strictObject({ id: z.string().min(1), identifier: z.string().min(1), title: z.string(), description: nullableString }),
  profile: z.strictObject({ id: z.string().min(1), name: z.string().min(1), configuration: profileConfigurationSchema }),
  roleAssignments: z.record(z.string(), z.strictObject({
    engineName: z.string().min(1), adapter: z.string().min(1), executable: nullableString, requestedModel: z.string().min(1),
    actualModel: nullableString, options: engineDefinitionSchema.nullable(), capabilities: capabilitySnapshotSchema,
    validationErrors: z.array(z.string()).optional()
  })),
  repositories: z.array(resolvedRepositorySchema).min(1), parallelGroup: nullableString, overrides: jsonRecord,
  policies: z.strictObject({
    permission: z.enum(["prompt", "worktree-autonomous"]), isolation: z.literal("worktree"),
    fallback: z.enum(["none", "explicit", "automatic"]), push: z.enum(["never", "approved", "automatic"]),
    draftPr: z.enum(["never", "approved", "automatic"]), merge: z.literal("human")
  }),
  warnings: z.array(z.string()), errors: z.array(z.string()), previewIssuedAt: timestamp, previewFingerprint: z.string().min(1)
});

export const agentRunSnapshotSchema = z.strictObject({
  id: z.string().min(1), issueId: z.string().min(1), profileId: nullableString, workflow: z.string().min(1),
  workflowVersion: z.number().int().positive(), schemaVersion: z.number().int().positive(), resolvedConfiguration: resolvedRunConfigurationSnapshotSchema,
  phase: runPhaseSchema, state: runStateSchema, primaryRepositoryId: z.string().min(1), baseRef: z.string().min(1),
  baseCommit: z.string().min(1), branch: z.string().min(1), worktreePath: z.string().min(1), parallelGroup: nullableString,
  eventCounter: z.number().int().nonnegative(), attemptCounter: z.number().int().nonnegative(), startedAt: nullableTimestamp,
  lastEventAt: timestamp, lastProgressAt: timestamp, completedAt: nullableTimestamp, outcome: nullableString,
  error: jsonRecord.nullable(), archivedAt: nullableTimestamp, createdAt: timestamp, updatedAt: timestamp
}).superRefine((run, context) => {
  const terminal = ["succeeded", "partial", "failed", "canceled", "crashed"].includes(run.state);
  if (terminal !== (run.completedAt !== null)) context.addIssue({ code: "custom", message: "Run terminal state and completedAt disagree." });
});

export const runRepositorySnapshotSchema = z.strictObject({
  runId: z.string().min(1), repositoryId: z.string().min(1), position: z.number().int().nonnegative(), baseRef: z.string().min(1),
  baseCommit: z.string().min(1), worktreePath: z.string().min(1), branch: z.string().min(1), isPrimary: z.boolean()
});

export const runAttemptSnapshotSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), number: z.number().int().positive(), reason: z.string().min(1),
  requestedEngine: jsonRecord, actualEngine: jsonRecord.nullable(), state: z.enum(["queued", "running", "succeeded", "failed", "canceled", "crashed"]),
  startedAt: nullableTimestamp, completedAt: nullableTimestamp, result: jsonRecord.nullable(), error: jsonRecord.nullable(), createdAt: timestamp
});

export const runParticipantSnapshotSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), attemptId: z.string().min(1), actor: z.string().min(1), role: orchestrationRoleSchema,
  adapter: z.string().min(1), requestedModel: z.string().min(1), actualModel: nullableString, providerSessionId: nullableString,
  capabilities: capabilitySnapshotSchema, processIdentity: jsonRecord.nullable(),
  state: z.enum(["queued", "running", "waiting", "succeeded", "failed", "stopped", "crashed"]),
  startedAt: nullableTimestamp, lastHeartbeatAt: nullableTimestamp, completedAt: nullableTimestamp
});

export const runEventSnapshotSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), sequence: z.number().int().positive(), attemptId: nullableString,
  participantId: nullableString, type: z.string().min(1), schemaVersion: z.number().int().positive(), data: jsonRecord,
  providerEventId: nullableString, createdAt: timestamp
});

export const runArtifactSnapshotSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), attemptId: nullableString, kind: z.string().min(1), title: z.string().min(1),
  localPath: nullableString, url: nullableString, sha256: nullableString, metadata: jsonRecord, attachmentId: nullableString,
  removedAt: nullableTimestamp, createdAt: timestamp
});

export const runInputRequestSnapshotSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), participantId: z.string().min(1), kind: z.enum(["input", "permission"]),
  prompt: z.string().min(1), operation: jsonRecord.nullable(), blocking: z.boolean(), state: z.enum(["pending", "approved", "denied", "answered", "expired"]),
  response: nullableString, requestedBy: z.string().min(1), respondedBy: nullableString, requestedAt: timestamp, respondedAt: nullableTimestamp
});

export const runVerificationSnapshotSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), attemptId: z.string().min(1), commitSha: z.string().min(1), command: commandSpecSchema,
  startedAt: timestamp, completedAt: timestamp, exitCode: z.number().int().nullable(), classification: verificationClassificationSchema,
  logArtifactId: nullableString, summary: jsonRecord
});

export const runReviewFindingSnapshotSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), participantId: z.string().min(1), fingerprint: z.string().min(1),
  severity: z.enum(["info", "warning", "blocking"]), source: z.enum(["binding", "adversarial"]), file: nullableString,
  location: nullableString, summary: z.string().min(1), evidence: z.string().min(1), resolution: nullableString,
  reconciliation: z.enum(["agreed", "binding_only", "adversary_only"]).nullable(), createdAt: timestamp
});

const actionPayloadSchemas = {
  provision_worktree: z.strictObject({ repositories: z.array(resolvedRepositorySchema).min(1) }),
  setup_command: z.strictObject({ command: commandSpecSchema }),
  run_participant: z.object({ role: orchestrationRoleSchema }).passthrough(),
  verify_commands: z.strictObject({ selfReport: participantResultSchema }),
  finalize: jsonRecord,
  push_branch: z.strictObject({ branch: z.string().min(1), publishDraftPr: z.boolean() }),
  publish_draft_pr: z.strictObject({ branch: z.string().min(1), push: jsonRecord }),
  graceful_stop: z.strictObject({ force: z.literal(false) }),
  force_stop: z.strictObject({ force: z.literal(true) }),
  deliver_input: z.strictObject({ requestId: z.string().min(1), participantId: z.string().min(1), providerSessionId: z.string().min(1), state: z.enum(["answered", "approved", "denied"]), response: z.string() }),
  resume_participant: z.strictObject({ participantId: z.string().min(1), providerSessionId: z.string().min(1), message: nullableString }),
  nudge_participant: z.strictObject({ participantId: z.string().min(1), providerSessionId: z.string().min(1), message: nullableString }),
  remove_raw_logs: z.object({ paths: z.array(z.string()), artifactIds: z.array(z.string()).optional(), allowUnmerged: z.boolean().optional() }).strict(),
  remove_worktree: z.object({ paths: z.array(z.string()), artifactIds: z.array(z.string()).optional(), allowUnmerged: z.boolean().optional() }).strict()
} as const;

export const runActionSnapshotSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), attemptId: nullableString, kind: z.string().min(1), idempotencyKey: z.string().min(1),
  payload: jsonRecord, state: z.enum(["queued", "claimed", "completed", "failed", "canceled"]), leaseOwner: nullableString,
  leaseExpiresAt: nullableTimestamp, attemptCount: z.number().int().nonnegative(), result: jsonRecord.nullable(), error: jsonRecord.nullable(),
  createdAt: timestamp, updatedAt: timestamp, completedAt: nullableTimestamp
}).superRefine((action, context) => {
  const schema = actionPayloadSchemas[action.kind as keyof typeof actionPayloadSchemas];
  if (!schema) context.addIssue({ code: "custom", message: `Unsupported run action kind ${action.kind}.`, path: ["kind"] });
  else {
    const parsed = schema.safeParse(action.payload);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: ["payload", ...issue.path] });
  }
  const claimed = action.state === "claimed";
  if (claimed !== (action.leaseOwner !== null && action.leaseExpiresAt !== null)) context.addIssue({ code: "custom", message: "Claimed action lease fields are inconsistent." });
  const terminal = ["completed", "failed", "canceled"].includes(action.state);
  if (terminal !== (action.completedAt !== null)) context.addIssue({ code: "custom", message: "Action terminal state and completedAt disagree." });
});

export const supervisorInstanceSnapshotSchema = z.strictObject({
  id: z.string().min(1), processIdentity: jsonRecord, version: z.string().min(1), capabilities: jsonRecord,
  startedAt: timestamp, lastHeartbeatAt: timestamp
});

export const rawLogSnapshotSchema = z.strictObject({ artifactId: z.string().min(1), path: z.string().min(1), sha256: nullableString, contents: z.string() });
