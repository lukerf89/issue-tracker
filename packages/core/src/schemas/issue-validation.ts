import { z } from "zod";

export function validateIssueAliases(input: Record<string, unknown>, ctx: z.RefinementCtx) {
  for (const ref of ["team", "state", "assignee", "project", "cycle", "parent"]) {
    if (input[ref] !== undefined && input[`${ref}Id`] !== undefined) {
      ctx.addIssue({ code: "custom", path: [ref], message: `Supply only ${ref} or ${ref}Id, not both.` });
    }
  }
}

export function validateIssueUpdate(input: Record<string, unknown>, ctx: z.RefinementCtx) {
  validateIssueAliases(input, ctx);
  if (!Object.entries(input).some(([key, value]) => !["identifier", "expectedRevision"].includes(key) && value !== undefined && (!Array.isArray(value) || value.length > 0))) {
    ctx.addIssue({ code: "custom", message: "Supply at least one issue field to update." });
  }
}
