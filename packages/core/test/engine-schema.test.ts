import { describe, expect, it } from "vitest";

import { engineDefinitionSchema } from "../src/index.js";

const claudeBase = { adapter: "claude-code" as const, executable: "claude", model: "fictional-model" };
const codexBase = { adapter: "codex" as const, executable: "codex", model: "fictional-model" };

describe("engineDefinitionSchema osSandbox guard", () => {
  it("accepts osSandbox for a claude-code engine", () => {
    const parsed = engineDefinitionSchema.safeParse({
      ...claudeBase,
      osSandbox: true,
      capabilities: { interactivePermissions: true }
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.osSandbox).toBe(true);
  });

  it("rejects osSandbox for a codex engine because Codex nests its own Seatbelt", () => {
    const parsed = engineDefinitionSchema.safeParse({ ...codexBase, sandbox: "workspace-write", osSandbox: true });
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(messages.some((message) => message.includes("osSandbox is only supported for claude-code"))).toBe(true);
  });

  it("allows a codex engine when osSandbox is left at its default of false", () => {
    const parsed = engineDefinitionSchema.safeParse({ ...codexBase, sandbox: "workspace-write" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.osSandbox).toBe(false);
  });
});
