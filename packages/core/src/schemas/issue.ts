import { z } from "zod";

import type {
  ArchiveIssueInput,
  AssignIssueInput,
  CreateIssueInput,
  ListIssueFilters,
  SearchIssuesInput,
  UnarchiveIssueInput,
  UpdateIssueInput
} from "../services/issue.js";
import {
  optionalNullableDateOnlyStringSchema,
  nonEmptyStringSchema,
  optionalIntegerSchema,
  optionalNullableStringSchema
} from "./common.js";
import { cycleRefSchema } from "./cycle.js";

export const prioritySchema = z.number().int().min(0).max(4);
const optionalPrioritySchema = prioritySchema.optional();
const optionalNullableCycleRefSchema = cycleRefSchema.nullable().optional();

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
  cycle: optionalNullableCycleRefSchema,
  cycleId: optionalNullableStringSchema,
  parent: optionalNullableStringSchema,
  parentId: optionalNullableStringSchema,
  estimate: z.number().int().nullable().optional(),
  dueDate: optionalNullableDateOnlyStringSchema,
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
  cycle: cycleRefSchema.optional(),
  limit: optionalIntegerSchema,
  includeArchived: z.boolean().optional()
}) satisfies z.ZodType<ListIssueFilters>;

export const searchInputSchema = listIssueFiltersSchema.extend({
  query: nonEmptyStringSchema
}) satisfies z.ZodType<SearchIssuesInput>;

export const updateIssueInputSchema = z.object({
  title: nonEmptyStringSchema.optional(),
  description: z.string().nullable().optional(),
  priority: optionalPrioritySchema,
  assignee: optionalNullableStringSchema,
  assigneeId: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  projectId: optionalNullableStringSchema,
  cycle: optionalNullableCycleRefSchema,
  cycleId: optionalNullableStringSchema,
  parent: optionalNullableStringSchema,
  parentId: optionalNullableStringSchema,
  estimate: z.number().int().nullable().optional(),
  dueDate: optionalNullableDateOnlyStringSchema,
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

export const assignIssueInputSchema = z.object({
  identifier: nonEmptyStringSchema,
  actor: nonEmptyStringSchema.nullable()
}) satisfies z.ZodType<AssignIssueInput>;

export const archiveIssueInputSchema = z.object({
  identifier: nonEmptyStringSchema
}) satisfies z.ZodType<ArchiveIssueInput>;

export const unarchiveIssueInputSchema = z.object({
  identifier: nonEmptyStringSchema
}) satisfies z.ZodType<UnarchiveIssueInput>;
