import { describe, expect, it } from "vitest";

import { createProgram } from "../src/index.js";

describe("tracker CLI placeholder", () => {
  it("prints Phase 0 usage help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: tracker [options]");
    expect(help).toContain("Local-first issue tracker CLI");
  });
});
