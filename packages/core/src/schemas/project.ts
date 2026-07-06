import { z } from "zod";

import type { ArchiveProjectInput, CreateProjectInput, UpdateProjectInput } from "../services/project.js";
import { includeArchivedSchema, nonEmptyStringSchema, optionalNullableStringSchema } from "./common.js";

export const projectStatusSchema = z.enum([
  "backlog",
  "planned",
  "started",
  "paused",
  "completed",
  "canceled"
]);

export const getProjectInputSchema = z.object({
  project: nonEmptyStringSchema
});

export const createProjectInputSchema = z.object({
  name: nonEmptyStringSchema,
  description: z.string().nullable().optional(),
  status: projectStatusSchema.optional(),
  leadId: optionalNullableStringSchema,
  startDate: optionalNullableStringSchema,
  targetDate: optionalNullableStringSchema
}) satisfies z.ZodType<CreateProjectInput>;

export const updateProjectInputSchema = createProjectInputSchema.partial() satisfies z.ZodType<UpdateProjectInput>;

export const updateProjectToolInputSchema = updateProjectInputSchema.extend({
  project: nonEmptyStringSchema
});

export const listProjectsInputSchema = includeArchivedSchema;

export const archiveProjectInputSchema = z.object({
  project: nonEmptyStringSchema
}) satisfies z.ZodType<ArchiveProjectInput>;

export const unarchiveProjectInputSchema = archiveProjectInputSchema;
