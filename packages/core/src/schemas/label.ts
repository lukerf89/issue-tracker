import { z } from "zod";

import type { CreateLabelInput, ListLabelsOptions } from "../services/label.js";
import { includeArchivedSchema, nonEmptyStringSchema, optionalNullableStringSchema } from "./common.js";

export const createLabelInputSchema = z.object({
  name: nonEmptyStringSchema,
  color: nonEmptyStringSchema.optional(),
  group: optionalNullableStringSchema
}) satisfies z.ZodType<CreateLabelInput>;

export const listLabelsInputSchema = includeArchivedSchema satisfies z.ZodType<ListLabelsOptions>;

export const archiveLabelInputSchema = z.object({
  label: nonEmptyStringSchema
});
