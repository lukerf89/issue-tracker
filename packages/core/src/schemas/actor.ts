import { z } from "zod";

import type { CreateActorInput, ListActorsOptions } from "../services/actor.js";
import { includeArchivedSchema, nonEmptyStringSchema } from "./common.js";

export const actorTypeSchema = z.enum(["human", "agent"]);

export const createActorInputSchema = z.object({
  type: actorTypeSchema,
  name: nonEmptyStringSchema,
  handle: nonEmptyStringSchema
}) satisfies z.ZodType<CreateActorInput>;

export const listActorsInputSchema =
  includeArchivedSchema satisfies z.ZodType<ListActorsOptions>;
