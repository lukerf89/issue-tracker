import { z } from "zod";

import type { ArchiveTeamInput, CreateTeamInput } from "../services/team.js";
import { includeArchivedSchema, nonEmptyStringSchema } from "./common.js";

export const createTeamInputSchema = z.object({
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema
}) satisfies z.ZodType<CreateTeamInput>;

export const listTeamsInputSchema = includeArchivedSchema;

export const archiveTeamInputSchema = z.object({
  team: nonEmptyStringSchema
}) satisfies z.ZodType<ArchiveTeamInput>;

export const unarchiveTeamInputSchema = archiveTeamInputSchema;
