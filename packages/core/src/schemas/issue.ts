import { z } from "zod";

import type {
  CreateIssueInput,
  ListIssueFilters,
  UpdateIssueInput
} from "../services/issue.js";
import {
  nonEmptyStringSchema,
  optionalIntegerSchema,
  optionalNullableStringSchema
} from "./common.js";

export const getIssueInputSchema = z.object({
  identifier: nonEmptyStringSchema
});

export const createIssueInputSchema = z.object({
  title: nonEmptyStringSchema,
  description: z.string().nullable().optional(),
  team: nonEmptyStringSchema.optional(),
  teamId: nonEmptyStringSchema.optional(),
  state: nonEmptyStringSchema.optional(),
  stateId: nonEmptyStringSchema.optional(),
  priority: optionalIntegerSchema,
  assignee: optionalNullableStringSchema,
  assigneeId: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  projectId: optionalNullableStringSchema,
  cycleId: optionalNullableStringSchema,
  parentId: optionalNullableStringSchema,
  estimate: z.number().int().nullable().optional(),
  dueDate: optionalNullableStringSchema,
  sortOrder: optionalIntegerSchema
}) satisfies z.ZodType<CreateIssueInput>;

export const listIssueFiltersSchema = z.object({
  state: nonEmptyStringSchema.optional(),
  assignee: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  team: nonEmptyStringSchema.optional(),
  limit: optionalIntegerSchema,
  includeArchived: z.boolean().optional()
}) satisfies z.ZodType<ListIssueFilters>;

export const updateIssueInputSchema = z.object({
  title: nonEmptyStringSchema.optional(),
  description: z.string().nullable().optional(),
  priority: optionalIntegerSchema,
  assignee: optionalNullableStringSchema,
  assigneeId: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  projectId: optionalNullableStringSchema,
  cycleId: optionalNullableStringSchema,
  parentId: optionalNullableStringSchema,
  estimate: z.number().int().nullable().optional(),
  dueDate: optionalNullableStringSchema,
  sortOrder: optionalIntegerSchema
}) satisfies z.ZodType<UpdateIssueInput>;

export const updateIssueToolInputSchema = updateIssueInputSchema.extend({
  identifier: nonEmptyStringSchema
});

export const moveIssueInputSchema = z.object({
  identifier: nonEmptyStringSchema,
  state: nonEmptyStringSchema
});
