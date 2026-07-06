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

export const prioritySchema = z.number().int().min(0).max(4);
const optionalPrioritySchema = prioritySchema.optional();

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
  priority: optionalPrioritySchema,
  assignee: optionalNullableStringSchema,
  assigneeId: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  projectId: optionalNullableStringSchema,
  cycleId: optionalNullableStringSchema,
  parentId: optionalNullableStringSchema,
  estimate: z.number().int().nullable().optional(),
  dueDate: optionalNullableStringSchema,
  sortOrder: optionalIntegerSchema,
  labels: z.array(nonEmptyStringSchema).optional()
}) satisfies z.ZodType<CreateIssueInput>;

export const listIssueFiltersSchema = z.object({
  state: nonEmptyStringSchema.optional(),
  assignee: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  team: nonEmptyStringSchema.optional(),
  priority: optionalPrioritySchema,
  label: nonEmptyStringSchema.optional(),
  limit: optionalIntegerSchema,
  includeArchived: z.boolean().optional()
}) satisfies z.ZodType<ListIssueFilters>;

export const updateIssueInputSchema = z.object({
  title: nonEmptyStringSchema.optional(),
  description: z.string().nullable().optional(),
  priority: optionalPrioritySchema,
  assignee: optionalNullableStringSchema,
  assigneeId: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  projectId: optionalNullableStringSchema,
  cycleId: optionalNullableStringSchema,
  parentId: optionalNullableStringSchema,
  estimate: z.number().int().nullable().optional(),
  dueDate: optionalNullableStringSchema,
  sortOrder: optionalIntegerSchema,
  labels: z.array(nonEmptyStringSchema).optional(),
  removeLabels: z.array(nonEmptyStringSchema).optional()
}) satisfies z.ZodType<UpdateIssueInput>;

export const updateIssueToolInputSchema = updateIssueInputSchema.extend({
  identifier: nonEmptyStringSchema
});

export const moveIssueInputSchema = z.object({
  identifier: nonEmptyStringSchema,
  state: nonEmptyStringSchema
});
