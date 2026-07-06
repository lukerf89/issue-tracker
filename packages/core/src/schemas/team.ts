import { z } from "zod";

import type { CreateTeamInput } from "../services/team.js";
import { includeArchivedSchema, nonEmptyStringSchema } from "./common.js";

export const createTeamInputSchema = z.object({
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema
}) satisfies z.ZodType<CreateTeamInput>;

export const listTeamsInputSchema = includeArchivedSchema;
