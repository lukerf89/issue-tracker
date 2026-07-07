import { z } from "zod";

import type {
  CreateSavedViewInput,
  DeleteSavedViewInput,
  ListIssuesWithViewInput,
  ResolveSavedViewInput
} from "../services/savedView.js";
import { nonEmptyStringSchema, optionalNullableStringSchema } from "./common.js";
import { listIssueFiltersSchema } from "./issue.js";

export const createSavedViewInputSchema = z.object({
  name: nonEmptyStringSchema,
  filters: listIssueFiltersSchema,
  description: optionalNullableStringSchema
}) satisfies z.ZodType<CreateSavedViewInput>;

export const listSavedViewsInputSchema = z.object({});

export const deleteSavedViewInputSchema = z.object({
  idOrName: nonEmptyStringSchema
}) satisfies z.ZodType<DeleteSavedViewInput>;

export const resolveSavedViewInputSchema = z.object({
  name: nonEmptyStringSchema
}) satisfies z.ZodType<ResolveSavedViewInput>;

export const listIssuesWithViewInputSchema = z.object({
  view: nonEmptyStringSchema.optional(),
  filters: listIssueFiltersSchema.optional()
}) satisfies z.ZodType<ListIssuesWithViewInput>;

export const listIssuesWithViewToolInputSchema = listIssueFiltersSchema.extend({
  view: nonEmptyStringSchema.optional()
});
