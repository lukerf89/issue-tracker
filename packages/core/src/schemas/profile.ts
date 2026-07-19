import { z } from "zod";

export const orchestrationRoleSchema = z.enum([
  "orchestrator", "planner", "implementer", "verifier", "bindingReviewer", "adversarialReviewer"
]);

export const profileConfigurationSchema = z.object({
  roles: z.object({
    orchestrator: z.string().min(1),
    planner: z.string().min(1),
    implementer: z.string().min(1),
    verifier: z.string().min(1),
    bindingReviewer: z.string().min(1),
    adversarialReviewer: z.string().min(1)
  }).strict(),
  reviewDepth: z.enum(["lite", "full", "auto"]).default("auto"),
  isolation: z.literal("worktree").default("worktree"),
  permissionPolicy: z.enum(["prompt", "worktree-autonomous"]).default("prompt"),
  fallbackPolicy: z.enum(["none", "explicit", "automatic"]).default("explicit"),
  pushPolicy: z.enum(["never", "approved", "automatic"]).default("approved"),
  draftPrPolicy: z.enum(["never", "approved", "automatic"]).default("approved"),
  mergePolicy: z.literal("human").default("human"),
  maxAddressCycles: z.number().int().min(0).max(5).default(2),
  stallThresholdMs: z.number().int().positive().default(300_000),
  issueStartedState: z.string().min(1).nullable().default(null),
  issueReviewState: z.string().min(1).nullable().default(null)
}).strict();

export const addProfileInputSchema = z.object({
  name: z.string().trim().min(1),
  workflow: z.literal("issue-delivery").default("issue-delivery"),
  configuration: profileConfigurationSchema,
  isDefault: z.boolean().default(false)
}).strict();
export const profileRefSchema = z.object({ profile: z.string().min(1) }).strict();
export const listProfilesInputSchema = z.object({ includeArchived: z.boolean().optional() }).strict();

export type ProfileConfiguration = z.infer<typeof profileConfigurationSchema>;
export type AddProfileInput = z.infer<typeof addProfileInputSchema>;
