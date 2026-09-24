import { z } from "zod";

import type { AddCommentInput } from "../services/comment.js";
import { idempotencyKeySchema, nonEmptyStringSchema, optionalNullableStringSchema } from "./common.js";

export const addCommentInputSchema = z.object({
  issue: nonEmptyStringSchema,
  expectedRevision: z.number().int().positive().optional(),
  body: nonEmptyStringSchema,
  parent: optionalNullableStringSchema,
  idempotencyKey: idempotencyKeySchema
}) satisfies z.ZodType<AddCommentInput>;
