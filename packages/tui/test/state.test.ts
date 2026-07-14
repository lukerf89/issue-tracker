import { describe, expect, it } from "vitest";

import {
  initialLinekeeperState,
  reduceLinekeeperState,
  selectedSection
} from "../src/state.js";
import { mapKeyToLinekeeperAction } from "../src/keys.js";

describe("Linekeeper key mapping and reducer", () => {
  it("moves through the issue list with j/k, gg, and G", () => {
    let state = initialLinekeeperState();

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("j", {}, state), 3);
    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("j", {}, state), 3);
    expect(state.selectedIndex).toBe(2);

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("k", {}, state), 3);
    expect(state.selectedIndex).toBe(1);

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("G", {}, state), 3);
    expect(state.selectedIndex).toBe(2);

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("g", {}, state), 3);
    expect(state.pendingG).toBe(true);
    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("g", {}, state), 3);
    expect(state.selectedIndex).toBe(0);
  });

  it("moves focus and detail sections without changing issues", () => {
    let state = initialLinekeeperState();

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("", { tab: true }, state), 4);
    expect(state.focus).toBe("detail");

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("]", {}, state), 4);
    expect(selectedSection(state)).toBe("subIssues");

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("[", {}, state), 4);
    expect(selectedSection(state)).toBe("metadata");

    state = reduceLinekeeperState(
      state,
      mapKeyToLinekeeperAction("", { tab: true, shift: true }, state),
      4
    );
    expect(state.focus).toBe("list");
  });

  it("captures command-mode input for core-backed actions", () => {
    let state = initialLinekeeperState();

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("m", {}, state), 1);
    expect(state.mode).toEqual({ kind: "move", input: "" });

    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("I", {}, state), 1);
    state = reduceLinekeeperState(state, mapKeyToLinekeeperAction("n", {}, state), 1);
    expect(state.mode).toEqual({ kind: "move", input: "In" });

    state = reduceLinekeeperState(
      state,
      mapKeyToLinekeeperAction("", { backspace: true }, state),
      1
    );
    expect(state.mode).toEqual({ kind: "move", input: "I" });

    state = reduceLinekeeperState(
      state,
      mapKeyToLinekeeperAction("", { return: true }, state),
      1
    );
    expect(state.mode).toBeNull();
  });

  it("maps activity, copy, and quit keys to distinct actions", () => {
    const state = initialLinekeeperState();

    expect(mapKeyToLinekeeperAction("A", {}, state)).toEqual({ type: "toggleActivity" });
    expect(mapKeyToLinekeeperAction("y", {}, state)).toEqual({ type: "copyIdentifier" });
    expect(mapKeyToLinekeeperAction("q", {}, state)).toEqual({ type: "quit" });
    expect(mapKeyToLinekeeperAction("?", {}, state)).toEqual({ type: "toggleHelp" });
  });

  it("maps arrow and page keys by focus", () => {
    const listState = initialLinekeeperState();

    expect(mapKeyToLinekeeperAction("", { upArrow: true }, listState)).toEqual({
      type: "moveSelection",
      delta: -1
    });
    expect(mapKeyToLinekeeperAction("", { downArrow: true }, listState)).toEqual({
      type: "moveSelection",
      delta: 1
    });
    expect(mapKeyToLinekeeperAction("", { pageDown: true }, listState)).toEqual({
      type: "pageSelection",
      delta: 1
    });
    expect(mapKeyToLinekeeperAction("", { return: true }, listState)).toEqual({
      type: "openSelected"
    });

    const detailState = { ...listState, focus: "detail" as const };

    expect(mapKeyToLinekeeperAction("", { upArrow: true }, detailState)).toEqual({
      type: "scrollDetail",
      delta: -1
    });
    expect(mapKeyToLinekeeperAction("", { downArrow: true }, detailState)).toEqual({
      type: "scrollDetail",
      delta: 1
    });
    expect(mapKeyToLinekeeperAction("", { escape: true }, detailState)).toEqual({
      type: "focusPrevious"
    });
    expect(mapKeyToLinekeeperAction("", { leftArrow: true }, detailState)).toEqual({
      type: "focusPrevious"
    });
  });

  it("scrolls the detail body and floors at zero", () => {
    let state = initialLinekeeperState();

    state = reduceLinekeeperState(state, { type: "scrollDetail", delta: 3 }, 5);
    expect(state.detailScroll).toBe(3);
    expect(state.focus).toBe("detail");

    state = reduceLinekeeperState(state, { type: "scrollDetail", delta: -10 }, 5);
    expect(state.detailScroll).toBe(0);

    state = reduceLinekeeperState(state, { type: "scrollDetail", delta: 2 }, 5);
    state = reduceLinekeeperState(state, { type: "resetDetailScroll" }, 5);
    expect(state.detailScroll).toBe(0);
  });

  it("resets detail scroll when the selected issue or focus changes", () => {
    let state = reduceLinekeeperState(initialLinekeeperState(), { type: "scrollDetail", delta: 4 }, 5);
    expect(state.detailScroll).toBe(4);

    state = reduceLinekeeperState(state, { type: "moveSelection", delta: 1 }, 5);
    expect(state.detailScroll).toBe(0);

    state = reduceLinekeeperState(state, { type: "scrollDetail", delta: 4 }, 5);
    state = reduceLinekeeperState(state, { type: "focusPrevious" }, 5);
    expect(state.detailScroll).toBe(0);
  });
});
