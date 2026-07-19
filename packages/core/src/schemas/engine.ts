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
  // Unlike Codex's runtime sandbox, this is a darwin-only kernel Seatbelt jail applied at spawn.
  // It gives Claude Code worktree containment as defense-in-depth beneath its permission hook.
  // Codex is excluded (see superRefine): it installs its own inner Seatbelt profile that cannot be
  // nested inside an outer sandbox-exec.
  osSandbox: z.boolean().default(false),
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
  // Claude Code can optionally use an OS jail, but autonomous mode still requires interactive
  // permissions: the jail confines reads while the durable hook adjudicates every mutating call.
  if (engine.adapter === "claude-code" && engine.permissionMode === "autonomous" && !engine.capabilities.interactivePermissions) {
    context.addIssue({ code: "custom", message: "Claude Code autonomous mode requires an engine that declares interactivePermissions, because the Seatbelt jail does not replace adjudication of each mutating tool call." });
  }
  if (engine.adapter === "codex" && engine.permissionMode === "autonomous" && engine.sandbox === "read-only") {
    context.addIssue({ code: "custom", message: "Autonomous Codex requires a writable sandbox." });
  }
  // Codex confines itself with an inner `--sandbox` Seatbelt profile; nested Seatbelt profiles
  // cannot be installed, so wrapping `codex exec` in the outer osSandbox jail would break Codex's
  // own sandbox init or deny its helper's reads. The jail is claude-code-only.
  if (engine.adapter === "codex" && engine.osSandbox) {
    context.addIssue({ code: "custom", message: "Codex applies its own --sandbox confinement and cannot run under the osSandbox Seatbelt jail; osSandbox is only supported for claude-code." });
  }
});

export const engineCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  engines: z.record(z.string().min(1), engineDefinitionSchema)
}).strict();

export type EngineDefinition = z.infer<typeof engineDefinitionSchema>;
export type EngineCatalog = z.infer<typeof engineCatalogSchema>;
