import { describe, expect, it } from "vitest";

import {
  issueListShortcutForEvent,
  isShortcutTypingTarget,
  nextSelectionIndex,
  type IssueListShortcutState
} from "../src/components/issue-list-shortcuts";

const baseState: IssueListShortcutState = {
  createOpen: false,
  hasSelection: true,
  pendingGo: false
};

describe("issue list shortcuts", () => {
  it("maps Linear-style list keys to actions", () => {
    expect(shortcut("c")).toEqual({ action: "openCreate", pendingGo: false });
    expect(shortcut("j")).toEqual({ action: "selectNext", pendingGo: false });
    expect(shortcut("k")).toEqual({ action: "selectPrevious", pendingGo: false });
    expect(shortcut("Enter")).toEqual({ action: "openSelected", pendingGo: false });
    expect(shortcut("/")).toEqual({ action: "focusSearch", pendingGo: false });
    expect(shortcut("Escape")).toEqual({ action: "clearSelection", pendingGo: false });
  });

  it("handles view-switch chords and ignores Enter without a selected issue", () => {
    expect(shortcut("g")).toEqual({ action: "none", pendingGo: true });
    expect(shortcut("b", { pendingGo: true })).toEqual({
      action: "goBoard",
      pendingGo: false
    });
    expect(shortcut("l", { pendingGo: true })).toEqual({
      action: "goList",
      pendingGo: false
    });
    expect(shortcut("Enter", { hasSelection: false })).toEqual({
      action: "none",
      pendingGo: false
    });
  });

  it("suppresses shortcuts while typing in text controls", () => {
    const input = document.createElement("input");
    input.type = "text";
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    expect(isShortcutTypingTarget(input)).toBe(true);
    expect(isShortcutTypingTarget(textarea)).toBe(true);
    expect(isShortcutTypingTarget(select)).toBe(true);
    expect(isShortcutTypingTarget(checkbox)).toBe(false);
    expect(shortcut("c", {}, input)).toEqual({ action: "none", pendingGo: false });
    expect(shortcut("/", {}, textarea)).toEqual({ action: "none", pendingGo: false });
    expect(shortcut("j", {}, select)).toEqual({ action: "none", pendingGo: false });
    expect(shortcut("c", {}, checkbox)).toEqual({ action: "openCreate", pendingGo: false });
  });

  it("closes an open create dialog with Escape and clamps list selection", () => {
    const input = document.createElement("input");

    expect(shortcut("Escape", { createOpen: true }, input)).toEqual({
      action: "closeCreate",
      pendingGo: false
    });
    expect(shortcut("j", { createOpen: true })).toEqual({
      action: "none",
      pendingGo: false
    });
    expect(nextSelectionIndex(null, "next", 3)).toBe(0);
    expect(nextSelectionIndex(null, "previous", 3)).toBe(2);
    expect(nextSelectionIndex(2, "next", 3)).toBe(2);
    expect(nextSelectionIndex(0, "previous", 3)).toBe(0);
    expect(nextSelectionIndex(null, "next", 0)).toBeNull();
  });
});

function shortcut(
  key: string,
  state: Partial<IssueListShortcutState> = {},
  target: EventTarget | null = null
) {
  return issueListShortcutForEvent(
    { key, target },
    {
      ...baseState,
      ...state
    }
  );
}
