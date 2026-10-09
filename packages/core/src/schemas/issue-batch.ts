import { z } from "zod";
import { nonEmptyStringSchema } from "./common.js";

export const batchMoveIssuesInputSchema = z.strictObject({
  moves: z.array(z.strictObject({ identifier: nonEmptyStringSchema, state: nonEmptyStringSchema, expectedRevision: z.number().int().positive().optional() })).min(1).max(100),
  onError: z.enum(["rollback", "continue"]).default("rollback")
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  for (const [index, move] of input.moves.entries()) {
    if (seen.has(move.identifier)) ctx.addIssue({ code: "custom", path: ["moves", index, "identifier"], message: "Duplicate issue in batch." });
    seen.add(move.identifier);
  }
});
export type BatchMoveIssuesInput = z.input<typeof batchMoveIssuesInputSchema>;
