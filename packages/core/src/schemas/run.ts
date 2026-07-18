import { z } from "zod";

export const runPhaseSchema = z.enum(["preflight", "plan", "implement", "verify", "review", "finalize", "complete"]);
export const runStateSchema = z.enum(["queued", "provisioning", "running", "waiting_for_input", "blocked", "stalled", "succeeded", "partial", "failed", "canceled", "crashed"]);
export const terminalRunStateSchema = z.enum(["succeeded", "partial", "failed", "canceled", "crashed"]);
export const verificationClassificationSchema = z.enum(["clean", "honest_partial", "fixable_partial", "audit_drift", "blocked", "engine_failure"]);

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
export const listRunsInputSchema = z.object({
  issue: z.string().min(1).optional(),
  state: runStateSchema.optional(),
  includeArchived: z.boolean().optional()
}).strict();
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
export const retryRunInputSchema = z.object({ run: z.string().uuid(), engine: z.string().min(1).optional() }).strict();

export type RunPhase = z.infer<typeof runPhaseSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type PreviewRunInput = z.infer<typeof previewRunInputSchema>;
export type StartRunInput = z.infer<typeof startRunInputSchema>;
