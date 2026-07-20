import { describe, expect, it } from "vitest";

import { engineDefinitionSchema } from "@issue-tracker/core";

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
