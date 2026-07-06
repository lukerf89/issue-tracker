import { describe, expect, it } from "vitest";

import { corePlaceholder } from "../src/index.js";

describe("core placeholder", () => {
  it("exports the Phase 0 public barrel placeholder", () => {
    expect(corePlaceholder).toEqual({
      packageName: "@issue-tracker/core",
      phase: "LF-54"
    });
  });
});
