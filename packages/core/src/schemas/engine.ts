import { z } from "zod";

export const engineAdapterSchema = z.enum(["claude-code", "codex", "fake"]);
export const engineCapabilitiesSchema = z.object({
  resume: z.boolean().default(false),
  redirect: z.boolean().default(false),
  interactivePermissions: z.boolean().default(false),
  structuredOutput: z.boolean().default(true),
  childParticipants: z.boolean().default(false),
  usage: z.boolean().default(false)
}).strict();

export const engineDefinitionSchema = z.object({
  adapter: engineAdapterSchema,
  executable: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  permissionMode: z.enum(["prompt", "autonomous"]).default("prompt"),
  envNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  capabilities: engineCapabilitiesSchema.default({
    resume: false,
    redirect: false,
    interactivePermissions: false,
    structuredOutput: true,
    childParticipants: false,
    usage: false
  })
}).strict().superRefine((engine, context) => {
  if (engine.adapter === "claude-code" && (engine.reasoningEffort || engine.sandbox)) {
    context.addIssue({ code: "custom", message: "Claude Code does not support reasoningEffort or sandbox." });
  }
  // Claude Code has no OS-level worktree sandbox, so autonomous mode is admissible only when the
  // engine declares interactive permissions: every mutating tool call is then adjudicated through a
  // durable tracker permission request rather than pre-approved. Containment here is policy-level,
  // not kernel-level as it is for a sandboxed Codex engine.
  if (engine.adapter === "claude-code" && engine.permissionMode === "autonomous" && !engine.capabilities.interactivePermissions) {
    context.addIssue({ code: "custom", message: "Claude Code autonomous mode requires an engine that declares interactivePermissions, because this supervisor cannot enforce a worktree-scoped sandbox and must adjudicate each tool call." });
  }
  if (engine.adapter === "codex" && engine.permissionMode === "autonomous" && engine.sandbox === "read-only") {
    context.addIssue({ code: "custom", message: "Autonomous Codex requires a writable sandbox." });
  }
});

export const engineCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  engines: z.record(z.string().min(1), engineDefinitionSchema)
}).strict();

export type EngineDefinition = z.infer<typeof engineDefinitionSchema>;
export type EngineCatalog = z.infer<typeof engineCatalogSchema>;
