import { z } from "zod";

import type { ListActivityInput, ListActivitySinceInput } from "../services/activity.js";
import { nonEmptyStringSchema } from "./common.js";

export const listActivityInputSchema = z.object({
  issue: nonEmptyStringSchema
}) satisfies z.ZodType<ListActivityInput>;

const cursorSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^(0|[1-9]\d*)$/)
]);

export const listActivitySinceInputSchema = z.object({
  cursor: cursorSchema.nullable().optional(),
  team: nonEmptyStringSchema.optional(),
  assignee: nonEmptyStringSchema.optional(),
  limit: z.number().int().positive().optional()
}) satisfies z.ZodType<ListActivitySinceInput>;
