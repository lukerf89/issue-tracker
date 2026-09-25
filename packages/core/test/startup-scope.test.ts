import { describe, expect, it } from "vitest";

import { AppErrorCode, isExplicitStartupScope, resolveStartupScope } from "../src/index.js";

describe("resolveStartupScope", () => {
  it("treats a team on its own as the default scope, not an explicit one", () => {
    expect(isExplicitStartupScope(undefined)).toBe(false);
    expect(isExplicitStartupScope({})).toBe(false);
    expect(isExplicitStartupScope({ filters: { team: "ENG" } })).toBe(false);
    expect(isExplicitStartupScope({ filters: { team: "ENG", state: undefined } })).toBe(false);
    expect(resolveStartupScope({ filters: { team: "ENG" } }, "ENG")).toBeNull();
    expect(resolveStartupScope({ filters: { team: "OPS" } }, "ENG")).toBeNull();

    expect(isExplicitStartupScope({ filters: { team: "ENG", label: "ci" } })).toBe(true);
    expect(isExplicitStartupScope({ search: "ci" })).toBe(true);
    expect(isExplicitStartupScope({ view: "Urgent" })).toBe(true);
    expect(isExplicitStartupScope({ filterText: "team=all" })).toBe(true);
    expect(resolveStartupScope({ filters: { team: "OPS", label: "ci" } }, "ENG"))
      .toEqual({ view: null, team: "OPS", filters: { team: "OPS", label: "ci" } });
  });

  it("composes view, filter text, named filters and search with the documented precedence", () => {
    expect(resolveStartupScope({
      view: "Urgent", filterText: 'project="Demo Project" team=all', filters: { state: "Todo" }, search: "ci"
    }, "ENG")).toEqual({ view: "Urgent", team: null, search: "ci", filters: { project: "Demo Project", state: "Todo" } });
    expect(resolveStartupScope({ filterText: "state=Todo", filters: { state: "Done" } })).toMatchObject({ filters: { state: "Done" } });
    expect(resolveStartupScope({ filterText: "team=all", filters: { team: "ENG" } })).toMatchObject({ team: "ENG", filters: { team: "ENG" } });
    expect(resolveStartupScope({ search: "ci" }, "ENG")).toEqual({ view: null, team: "ENG", search: "ci", filters: {} });
    expect(resolveStartupScope({ view: "Urgent" }, "ENG")).toEqual({ view: "Urgent", filters: {} });
    expect(() => resolveStartupScope({ filterText: "bogus=1" }))
      .toThrow(expect.objectContaining({ code: AppErrorCode.VALIDATION_FAILED }));
  });
});
