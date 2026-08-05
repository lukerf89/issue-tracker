import { describe, expect, it } from "vitest";

import type { LinekeeperData } from "../src/data.js";
import { buildFilterChips, padColumn, truncate } from "../src/format.js";

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

// buildFilterChips reads only filters/search plus the states/actors/projects/
// cycles lookup tables, so a partial LinekeeperData is enough to exercise it.
function chipData(overrides: Partial<LinekeeperData>): LinekeeperData {
  return {
    states: [],
    actors: [],
    projects: [],
    cycles: [],
    search: null,
    filters: {},
    ...overrides
  } as LinekeeperData;
}

describe("buildFilterChips", () => {
  it("renders no chips for an empty filter set", () => {
    expect(buildFilterChips(chipData({}))).toEqual([]);
  });

  it("resolves stored ids to human-readable names", () => {
    const chips = buildFilterChips(
      chipData({
        states: [{ id: "state-1", name: "Todo" }] as LinekeeperData["states"],
        actors: [{ id: "actor-1", handle: "codex" }] as LinekeeperData["actors"],
        projects: [{ id: "proj-1", name: "Hub" }] as LinekeeperData["projects"],
        filters: { state: "state-1", assignee: "actor-1", project: "proj-1", priority: 2 }
      })
    );

    expect(chips).toEqual([
      { key: "state", label: "state=Todo" },
      { key: "assignee", label: "@codex" },
      { key: "priority", label: "priority:High" },
      { key: "project", label: "project:Hub" }
    ]);
  });

  it("echoes the raw value when an id cannot be resolved", () => {
    const chips = buildFilterChips(chipData({ filters: { state: "Todo", project: "Hub" } }));

    expect(chips).toEqual([
      { key: "state", label: "state=Todo" },
      { key: "project", label: "project:Hub" }
    ]);
  });

  it("resolves a numeric cycle filter to the cycle name", () => {
    const cycles = [
      { id: "cycle-uuid", number: 3, name: "Sprint 3" },
      { id: "cycle-unnamed", number: 4, name: null }
    ] as LinekeeperData["cycles"];

    expect(buildFilterChips(chipData({ cycles, filters: { cycle: 3 } }))).toEqual([
      { key: "cycle", label: "cycle:Sprint 3" }
    ]);
    // An unnamed cycle falls back to "Cycle N", still resolved by number.
    expect(buildFilterChips(chipData({ cycles, filters: { cycle: 4 } }))).toEqual([
      { key: "cycle", label: "cycle:Cycle 4" }
    ]);
    // An unmatched number shows the raw value rather than a blank chip.
    expect(buildFilterChips(chipData({ cycles, filters: { cycle: 9 } }))).toEqual([
      { key: "cycle", label: "cycle:9" }
    ]);
  });

  it("renders barewords for null/archived filters and search as its own chip", () => {
    const chips = buildFilterChips(
      chipData({
        search: "pagination",
        filters: {
          assignee: null,
          project: null,
          label: "bug",
          includeArchived: true
        }
      })
    );

    expect(chips).toEqual([
      { key: "assignee", label: "unassigned" },
      { key: "project", label: "no-project" },
      { key: "label", label: "label:bug" },
      { key: "includeArchived", label: "archived" },
      { key: "search", label: "/pagination" }
    ]);
  });
});
