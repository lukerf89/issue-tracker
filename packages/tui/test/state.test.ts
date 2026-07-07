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
  });
});
