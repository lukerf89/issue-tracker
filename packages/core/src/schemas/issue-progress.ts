import { z } from "zod";
import { nonEmptyStringSchema } from "./common.js";

const criterionStatus = z.enum(["pending", "passed", "failed", "waived"]);
const blockerKind = z.enum(["network", "dependency", "human_review", "evaluation_data", "other"]);
const criterionAdd = z.strictObject({ type: z.literal("criterion"), action: z.literal("add"), text: nonEmptyStringSchema, status: criterionStatus.default("pending"), evidenceUrl: z.url().nullable().optional() });
const criterionUpdate = z.strictObject({ type: z.literal("criterion"), action: z.literal("update"), id: z.uuid(), text: nonEmptyStringSchema.optional(), status: criterionStatus.optional(), evidenceUrl: z.url().nullable().optional(), archived: z.boolean().optional() });
const blockerAdd = z.strictObject({ type: z.literal("blocker"), action: z.literal("add"), kind: blockerKind, description: nonEmptyStringSchema, unblockAction: nonEmptyStringSchema, owner: nonEmptyStringSchema });
const blockerUpdate = z.strictObject({ type: z.literal("blocker"), action: z.literal("update"), id: z.uuid(), kind: blockerKind.optional(), description: nonEmptyStringSchema.optional(), unblockAction: nonEmptyStringSchema.optional(), owner: nonEmptyStringSchema.optional(), resolved: z.boolean().optional() });

export const updateIssueProgressInputSchema = z.strictObject({
  identifier: nonEmptyStringSchema,
  expectedRevision: z.number().int().positive().optional(),
  operations: z.array(z.union([criterionAdd, criterionUpdate, blockerAdd, blockerUpdate])).min(1).max(50)
});
export type UpdateIssueProgressInput = z.input<typeof updateIssueProgressInputSchema>;
export const getIssueProgressInputSchema = z.strictObject({
  identifier: nonEmptyStringSchema,
  childLimit: z.number().int().min(1).max(250).default(50),
  childOffset: z.number().int().nonnegative().default(0)
});
export type GetIssueProgressInput = z.input<typeof getIssueProgressInputSchema>;
