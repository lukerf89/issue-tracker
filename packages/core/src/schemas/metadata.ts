import { z } from "zod";

import { nonEmptyStringSchema } from "./common.js";

export const describeTrackerInputSchema = z.object({});

export const listStatesInputSchema = z.object({
  team: nonEmptyStringSchema
});
