import { describe, expect, it } from "vitest";

import { padColumn, truncate } from "../src/format.js";

describe("Linekeeper formatting helpers", () => {
  it("truncates text without exceeding the requested width", () => {
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdef", 5)).toBe("ab...");
    expect(truncate("abcdef", 3)).toBe("...");
    expect(truncate("abcdef", 2)).toBe("..");
    expect(truncate("abcdef", 0)).toBe("");
  });

  it("pads clipped values to fixed-width columns", () => {
    expect(padColumn("abc", 5)).toBe("abc  ");
    expect(padColumn("abcdef", 5)).toBe("ab...");
  });
});
