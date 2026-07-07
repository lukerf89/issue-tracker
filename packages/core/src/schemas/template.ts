import { z } from "zod";

import type {
  CreateIssueFromTemplateInput,
  CreateIssueFromTemplateOverrides,
  CreateTemplateInput,
  DeleteTemplateInput
} from "../services/template.js";
import { nonEmptyStringSchema, optionalNullableStringSchema } from "./common.js";
import { createIssueInputSchema, prioritySchema } from "./issue.js";

export const templateLabelsSchema = z.array(nonEmptyStringSchema);

export const createTemplateInputSchema = z.object({
  name: nonEmptyStringSchema,
  title: optionalNullableStringSchema,
  description: z.string().nullable().optional(),
  priority: prioritySchema.nullable().optional(),
  team: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  labels: templateLabelsSchema.optional()
}) satisfies z.ZodType<CreateTemplateInput>;

export const listTemplatesInputSchema = z.object({});

export const deleteTemplateInputSchema = z.object({
  name: nonEmptyStringSchema
}) satisfies z.ZodType<DeleteTemplateInput>;

export const createIssueFromTemplateOverridesSchema =
  createIssueInputSchema.partial() satisfies z.ZodType<CreateIssueFromTemplateOverrides>;

export const createIssueFromTemplateInputSchema = z.object({
  name: nonEmptyStringSchema,
  overrides: createIssueFromTemplateOverridesSchema.optional()
}) satisfies z.ZodType<CreateIssueFromTemplateInput>;
