import { z } from "zod";

import type { AddCommentInput } from "../services/comment.js";
import { nonEmptyStringSchema, optionalNullableStringSchema } from "./common.js";

export const addCommentInputSchema = z.object({
  issue: nonEmptyStringSchema,
  body: nonEmptyStringSchema,
  parent: optionalNullableStringSchema
}) satisfies z.ZodType<AddCommentInput>;
