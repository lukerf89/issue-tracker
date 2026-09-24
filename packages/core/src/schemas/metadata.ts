import { z } from "zod";

import { nonEmptyStringSchema } from "./common.js";

export const describeTrackerInputSchema = z.strictObject({
  team: nonEmptyStringSchema.optional().describe("Scope teams and states by team key or ID. Labels and projects are workspace-global."),
  sections: z.array(z.enum(["teams", "priorities", "labelGroups", "projects", "actor"])).min(1).optional()
    .describe("Sections to return; default all. Each response carries metadataRevision, a hash of the returned sections."),
  compact: z.boolean().optional().describe("Omit project descriptions and use small project references. Default false for compatibility.")
});

export const listStatesInputSchema = z.object({
  team: nonEmptyStringSchema
});
