import { z } from "zod";

export const commandSpecSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  envNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([])
}).strict();

export const addRepositoryInputSchema = z.object({
  name: z.string().trim().min(1),
  path: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  remote: z.string().min(1).nullable().optional(),
  setupCommand: commandSpecSchema.nullable().optional(),
  testCommand: commandSpecSchema,
  verificationCommand: commandSpecSchema
}).strict();

export const repositoryRefSchema = z.object({ repository: z.string().min(1) }).strict();
export const listRepositoriesInputSchema = z.object({ includeArchived: z.boolean().optional() }).strict();
export const associateRepositoryInputSchema = z.object({
  repository: z.string().min(1),
  project: z.string().min(1).optional(),
  issue: z.string().min(1).optional(),
  position: z.number().int().nonnegative().default(0),
  isDefault: z.boolean().default(false),
  overrideKind: z.enum(["replace", "additional"]).default("replace")
}).strict().refine((input) => Boolean(input.project) !== Boolean(input.issue), {
  message: "Exactly one of project or issue is required."
});

export type CommandSpec = z.infer<typeof commandSpecSchema>;
export type AddRepositoryInput = z.infer<typeof addRepositoryInputSchema>;
export type AssociateRepositoryInput = z.infer<typeof associateRepositoryInputSchema>;
