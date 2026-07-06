import { z } from "zod";

import type { ListActivityInput } from "../services/activity.js";
import { nonEmptyStringSchema } from "./common.js";

export const listActivityInputSchema = z.object({
  issue: nonEmptyStringSchema
}) satisfies z.ZodType<ListActivityInput>;
