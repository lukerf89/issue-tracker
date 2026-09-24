import { z } from "zod";

import { orchestrationRoleSchema } from "./profile.js";

export const runPhaseSchema = z.enum(["preflight", "plan", "implement", "verify", "review", "finalize", "complete"]);
export const runStateSchema = z.enum(["queued", "provisioning", "running", "waiting_for_input", "blocked", "stalled", "succeeded", "partial", "failed", "canceled", "crashed"]);
export const terminalRunStateSchema = z.enum(["succeeded", "partial", "failed", "canceled", "crashed"]);
export const verificationClassificationSchema = z.enum(["clean", "honest_partial", "fixable_partial", "audit_drift", "blocked", "engine_failure"]);

export const reviewFindingResultSchema = z.object({
  severity: z.enum(["info", "warning", "blocking"]),
  file: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  summary: z.string().min(1),
  evidence: z.string().min(1)
}).strict();

export const participantResultSchema = z.object({
  role: orchestrationRoleSchema,
  summary: z.string().min(1),
  files: z.array(z.string()),
  tests: z.array(z.string()),
  risks: z.array(z.string()),
  findings: z.array(reviewFindingResultSchema),
  verifiedTestsPassed: z.boolean(),
  riskNotes: z.array(z.string()),
  risk: z.enum(["low", "medium", "high"]).optional(),
  estimatedSize: z.string().min(1).optional()
}).strict().superRefine((result, context) => {
  if (result.role === "planner" && !result.risk) context.addIssue({ code: "custom", path: ["risk"], message: "Planner results require an overall risk level." });
  if (result.role === "planner" && !result.estimatedSize) context.addIssue({ code: "custom", path: ["estimatedSize"], message: "Planner results require an estimated size." });
});

export const participantResultJsonSchema = z.toJSONSchema(participantResultSchema);

export const previewRunInputSchema = z.object({
  issue: z.string().min(1),
  profile: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  parallelGroup: z.string().min(1).optional(),
  overrides: z.record(z.string(), z.unknown()).optional()
}).strict();
export const startRunInputSchema = previewRunInputSchema.extend({
  previewFingerprint: z.string().min(16),
  confirmWarnings: z.array(z.string()).default([])
}).strict();
export const runRefSchema = z.object({ run: z.string().uuid() }).strict();
const runPageCursorSchema = z.string().min(1).max(4096);
const runPageLimitSchema = z.number().int().min(1).max(100).default(25);
export const listRunsInputSchema = z.object({
  issue: z.string().min(1).optional(),
  state: runStateSchema.optional(),
  includeArchived: z.boolean().optional(),
  cursor: runPageCursorSchema.optional(),
  limit: runPageLimitSchema
}).strict();
/** `summary` is a bounded, compact projection; `full` is the hydrated run with configuration and every related collection. */
export const runViewSchema = z.enum(["summary", "full"]);
export const getRunInputSchema = runRefSchema.extend({ view: runViewSchema.default("full") }).strict();
/** Run-returning mutations (stop/resume/nudge/archive) accept the same view selector as get_run. */
export const runMutationViewSchema = runRefSchema.extend({ view: runViewSchema.default("full") }).strict();
/** Related collections of a run that can be read independently, in hydrated-run order. */
export const runRecordCollectionSchema = z.enum(["repositories", "attempts", "participants", "artifacts", "inputRequests", "verifications", "reviewFindings", "pendingActions"]);
export const listRunRecordsInputSchema = z.object({
  run: z.string().uuid(),
  collection: runRecordCollectionSchema,
  cursor: runPageCursorSchema.optional(),
  limit: runPageLimitSchema
}).strict();
export const listRunArtifactsInputSchema = runRefSchema.extend({ cursor: runPageCursorSchema.optional(), limit: runPageLimitSchema }).strict();
export const listRunEventsInputSchema = z.object({
  run: z.string().uuid(),
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(1000).default(100)
}).strict();
export const transitionRunInputSchema = z.object({
  run: z.string().uuid(),
  expectedState: runStateSchema,
  state: runStateSchema,
  phase: runPhaseSchema.optional(),
  outcome: z.string().nullable().optional(),
  error: z.record(z.string(), z.unknown()).nullable().optional()
}).strict();
export const recordProviderEventInputSchema = z.object({
  run: z.string().uuid(),
  attemptId: z.string().uuid(),
  participantId: z.string().uuid(),
  providerEventId: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  progress: z.boolean().default(false)
}).strict();
export const respondRunInputSchema = z.object({
  run: z.string().uuid(), request: z.string().uuid(), response: z.string().min(1)
}).strict();
export const resolvePermissionInputSchema = z.object({
  run: z.string().uuid(), request: z.string().uuid(), decision: z.enum(["approved", "denied"])
}).strict();
export const retryRunInputSchema = z.object({ run: z.string().uuid(), engine: z.string().min(1).optional(), view: runViewSchema.default("full") }).strict();
export const participantFailureCodeSchema = z.enum([
  "provider_authentication_failed", "provider_model_unavailable", "provider_schema_rejected", "provider_exit_nonzero",
  "provider_result_missing", "provider_result_invalid", "provider_process_crashed"
]);
export const completeParticipantActionInputSchema = z.object({
  actionId: z.string().uuid(), supervisorId: z.string().min(1), participantId: z.string().uuid(),
  result: z.object({
    role: orchestrationRoleSchema, sessionId: z.string().min(1).nullable(), actualModel: z.string().min(1).nullable(), exitCode: z.number().int().nullable(),
    structuredResult: z.record(z.string(), z.unknown()).nullable(),
    failure: z.object({ code: participantFailureCodeSchema, message: z.string().min(1) }).strict().nullable().optional()
  }).strict()
}).strict();

export type RunPhase = z.infer<typeof runPhaseSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type RunView = z.infer<typeof runViewSchema>;
export type RunRecordCollection = z.infer<typeof runRecordCollectionSchema>;
export type ListRunsPageInput = z.input<typeof listRunsInputSchema>;
export type ListRunRecordsInput = z.input<typeof listRunRecordsInputSchema>;
export type ParticipantResult = z.infer<typeof participantResultSchema>;
export type PreviewRunInput = z.infer<typeof previewRunInputSchema>;
export type StartRunInput = z.infer<typeof startRunInputSchema>;
export type CompleteParticipantActionInput = z.infer<typeof completeParticipantActionInputSchema>;
export type ParticipantFailureCode = z.infer<typeof participantFailureCodeSchema>;
