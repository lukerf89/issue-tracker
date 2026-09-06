import { z } from "zod";
import { validateIssueAliases, validateIssueUpdate } from "./issue-validation.js";

import type {
  ArchiveIssueInput,
  AssignIssueInput,
  CreateIssueInput,
  ListIssueFilters,
  SearchIssuesInput,
  UnarchiveIssueInput,
  UpdateIssueInput
} from "../services/issue.js";
import { ISSUE_PROJECTABLE_FIELDS } from "../services/issue.js";
import {
  dateOnlyStringSchema,
  cursorSchema,
  optionalNullableDateOnlyStringSchema,
  nonEmptyStringSchema,
  optionalIntegerSchema,
  optionalNullableStringSchema
} from "./common.js";
import { cycleRefSchema } from "./cycle.js";

export const prioritySchema = z.number().int().min(0).max(4);
const optionalPrioritySchema = prioritySchema.optional();
const optionalNullableCycleRefSchema = cycleRefSchema.nullable().optional();

export const getIssueInputSchema = z.strictObject({
  identifier: nonEmptyStringSchema,
  comments: z.enum(["none", "latest", "all"]).optional(),
  commentCursor: cursorSchema.optional(),
  commentLimit: z.number().int().positive().max(100).optional()
});

export const createIssueInputSchema = z.strictObject({
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
  labels: z.array(nonEmptyStringSchema).optional().describe("Add labels by name or ID; does not replace existing labels."),
  blockedBy: z.array(nonEmptyStringSchema).optional().describe("Add blocking issue identifiers or IDs; use removeBlockedBy to remove edges."),
  blocks: z.array(nonEmptyStringSchema).optional(),
  // Bounded; blank/whitespace keys are normalized to "no key" by the service, so an empty
  // string stays back-compatible with today's keyless create rather than erroring.
  idempotencyKey: z.string().max(255).nullable().optional()
}).superRefine(validateIssueAliases) satisfies z.ZodType<CreateIssueInput>;

export const listIssueFiltersSchema = z.strictObject({
  stateType: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]).optional(),
  ready: z.boolean().optional().describe("Active backlog/unstarted issue with no active nonterminal blockers; assignment is a separate filter."),
  parent: optionalNullableStringSchema,
  blockedBy: nonEmptyStringSchema.optional(),
  blocks: nonEmptyStringSchema.optional(),
  repository: nonEmptyStringSchema.optional().describe("Effective repository ID/name; issue overrides replace project routing."),
  updatedSince: z.iso.datetime({ offset: true }).optional(),
  dueFrom: dateOnlyStringSchema.optional(),
  dueTo: dateOnlyStringSchema.optional(),
  sort: z.enum(["identifier", "priority", "updatedAt"]).optional().describe("Lists default to identifier; search defaults to relevance. Priority 0 sorts last; updatedAt sorts newest first."),
  state: nonEmptyStringSchema.optional(),
  assignee: optionalNullableStringSchema,
  project: optionalNullableStringSchema,
  team: nonEmptyStringSchema.optional(),
  priority: optionalPrioritySchema,
  label: nonEmptyStringSchema.optional(),
  cycle: cycleRefSchema.optional(),
  limit: z.number().int().min(1).max(250).optional().describe("Page size: 1–250; default 50 for paginated reads."),
  includeArchived: z.boolean().optional()
}).refine((input) => !input.dueFrom || !input.dueTo || input.dueFrom <= input.dueTo, { path: ["dueTo"], message: "dueTo must be on or after dueFrom." }) satisfies z.ZodType<ListIssueFilters>;

export const searchInputSchema = listIssueFiltersSchema.safeExtend({
  query: nonEmptyStringSchema.describe("Free text: alphanumeric tokens are ANDed prefix matches; FTS operators are literal text.")
}) satisfies z.ZodType<SearchIssuesInput>;

export const issueProjectionFieldSchema = z.enum(ISSUE_PROJECTABLE_FIELDS);

export const issuePageOptionsSchema = listIssueFiltersSchema.safeExtend({
  cursor: cursorSchema.optional(),
  fields: z.array(issueProjectionFieldSchema).optional()
});

export const searchPageInputSchema = issuePageOptionsSchema.safeExtend({
  query: nonEmptyStringSchema.describe("Free text: alphanumeric tokens are ANDed prefix matches; FTS operators are literal text.")
});

export const updateIssueInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive().optional(),
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
  labels: z.array(nonEmptyStringSchema).optional().describe("Add labels by name or ID; does not replace existing labels."),
  removeLabels: z.array(nonEmptyStringSchema).optional(),
  blockedBy: z.array(nonEmptyStringSchema).optional().describe("Add blocking issue identifiers or IDs; use removeBlockedBy to remove edges."),
  removeBlockedBy: z.array(nonEmptyStringSchema).optional(),
  blocks: z.array(nonEmptyStringSchema).optional(),
  removeBlocks: z.array(nonEmptyStringSchema).optional()
}).superRefine(validateIssueUpdate) satisfies z.ZodType<UpdateIssueInput>;

export const updateIssueToolInputSchema = updateIssueInputSchema.safeExtend({
  identifier: nonEmptyStringSchema
});

export const moveIssueInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive().optional(),
  identifier: nonEmptyStringSchema,
  state: nonEmptyStringSchema
});

export const assignIssueInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive().optional(),
  identifier: nonEmptyStringSchema,
  actor: nonEmptyStringSchema.nullable()
}) satisfies z.ZodType<AssignIssueInput>;

export const archiveIssueInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive().optional(),
  identifier: nonEmptyStringSchema
}) satisfies z.ZodType<ArchiveIssueInput>;

export const unarchiveIssueInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive().optional(),
  identifier: nonEmptyStringSchema
}) satisfies z.ZodType<UnarchiveIssueInput>;

export const claimIssueInputSchema = archiveIssueInputSchema;
