import { z } from "zod";

import type {
  ListActivityInput,
  ListActivityPageInput,
  ListActivitySinceInput
} from "../services/activity.js";
import { nonEmptyStringSchema } from "./common.js";

export const listActivityInputSchema = z.object({
  issue: nonEmptyStringSchema
}) satisfies z.ZodType<ListActivityInput>;

const cursorSchema = z.union([
  z.number().int().nonnegative(),
  z.string()
    .regex(/^(0|[1-9]\d*)$/)
    .refine((value) => Number.isSafeInteger(Number(value)), "cursor must be a safe integer")
]);

/** Page size for activity feeds and paged history (defaults applied in core). */
export const activityLimitSchema = z.number().int().min(1).max(500);

export const listActivitySinceInputSchema = z.object({
  cursor: cursorSchema.nullable().optional(),
  team: nonEmptyStringSchema.optional(),
  assignee: nonEmptyStringSchema.optional(),
  issue: nonEmptyStringSchema.optional(),
  project: nonEmptyStringSchema.optional(),
  limit: activityLimitSchema.optional()
}) satisfies z.ZodType<ListActivitySinceInput>;

export const listActivityPageInputSchema = z.object({
  issue: nonEmptyStringSchema,
  after: cursorSchema.optional(),
  limit: activityLimitSchema.optional(),
  full: z.boolean().optional()
}).strict().superRefine((value, ctx) => {
  if (value.full === true && (value.after !== undefined || value.limit !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "full cannot be combined with after or limit.",
      path: ["full"]
    });
  }
}) satisfies z.ZodType<ListActivityPageInput>;
