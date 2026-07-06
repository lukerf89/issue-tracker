import { describe, expect, it } from "vitest";

import { mcpPlaceholder } from "../src/index.js";

describe("mcp placeholder", () => {
  it("exports the Phase 0 MCP placeholder", () => {
    expect(mcpPlaceholder).toEqual({
      packageName: "@issue-tracker/mcp",
      phase: "LF-54"
    });
  });
});
