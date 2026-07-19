import { describe, expect, it } from "vitest";

import { engineDefinitionSchema } from "../src/index.js";

const claudeBase = { adapter: "claude-code" as const, executable: "claude", model: "fictional-model" };
const codexBase = { adapter: "codex" as const, executable: "codex", model: "fictional-model" };

describe("engine definition schema", () => {
  it("accepts writable roots for Codex with the workspace-write sandbox", () => {
    const result = engineDefinitionSchema.safeParse({
      adapter: "codex",
      executable: "codex",
      model: "m",
      sandbox: "workspace-write",
      writableRoots: ["/tmp/x"]
    });

    expect(result.success).toBe(true);
  });

  it.each([
    { adapter: "claude-code", executable: "claude", model: "m", writableRoots: ["/tmp/x"] },
    {
      adapter: "codex",
      executable: "codex",
      model: "m",
      sandbox: "read-only",
      writableRoots: ["/tmp/x"]
    },
    {
      adapter: "codex",
      executable: "codex",
      model: "m",
      sandbox: "danger-full-access",
      writableRoots: ["/tmp/x"]
    }
  ])("rejects writable roots for an incompatible engine", (engine) => {
    const result = engineDefinitionSchema.safeParse(engine);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues.map((issue) => issue.message)).toContainEqual(
        expect.stringContaining("writableRoots requires Codex")
      );
    }
  });
});

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
