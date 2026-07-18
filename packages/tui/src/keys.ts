import type {
  LinekeeperAction,
  LinekeeperCommandKind,
  LinekeeperUiState
} from "./state.js";

export interface LinekeeperKeyState {
  tab?: boolean;
  shift?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

export type LinekeeperKeyAction =
  | LinekeeperAction
  | { type: "quit" }
  | { type: "copyIdentifier" }
  | { type: "openSelected" }
  | { type: "pageSelection"; delta: -1 | 1 }
  | { type: "toggleHelp" }
  | { type: "previewRun" }
  | { type: "stopRun" }
  | { type: "toggleFleet" }
  | { type: "none" };

const normalModeKeys: Record<string, LinekeeperCommandKind> = {
  "/": "search",
  f: "filter",
  v: "view",
  n: "new",
  m: "move",
  p: "priority",
  a: "assign",
  l: "labels",
  c: "comment",
  s: "subIssue",
  b: "link"
  ,e: "runResponse"
};

export function mapKeyToLinekeeperAction(
  input: string,
  key: LinekeeperKeyState,
  state: LinekeeperUiState
): LinekeeperKeyAction {
  if (key.ctrl && input === "c") return { type: "quit" };

  if (state.mode) {
    if (key.return) return { type: "submitMode" };
    if (key.escape) return { type: "cancelMode" };
    if (key.backspace || key.delete) return { type: "backspaceModeInput" };
    if (input.length > 0 && !key.tab) return { type: "appendModeInput", value: input };
    return { type: "none" };
  }

  if (input === "q") return { type: "quit" };
  if (key.tab) return key.shift ? { type: "focusPrevious" } : { type: "focusNext" };
  if (input === "?") return { type: "toggleHelp" };
  if (input === "r") return { type: "previewRun" };
  if (input === "x") return { type: "stopRun" };
  if (input === "F") return { type: "toggleFleet" };

  // Focus-specific navigation. The list is the default full-screen view; the
  // detail view is opened with Enter and scrolls its own body.
  if (state.focus === "detail") {
    if (key.escape || key.leftArrow || key.return) return { type: "focusPrevious" };
    if (key.upArrow || input === "k") return { type: "scrollDetail", delta: -1 };
    if (key.downArrow || input === "j") return { type: "scrollDetail", delta: 1 };
    if (key.pageUp) return { type: "pageSelection", delta: -1 };
    if (key.pageDown) return { type: "pageSelection", delta: 1 };
    if (input === "]") return { type: "sectionNext" };
    if (input === "[") return { type: "sectionPrevious" };
  } else {
    if (key.return) return { type: "openSelected" };
    if (key.upArrow || input === "k") return { type: "moveSelection", delta: -1 };
    if (key.downArrow || input === "j") return { type: "moveSelection", delta: 1 };
    if (key.pageUp) return { type: "pageSelection", delta: -1 };
    if (key.pageDown) return { type: "pageSelection", delta: 1 };
    if (input === "G") return { type: "selectBottom" };
    if (input === "]") return { type: "sectionNext" };
    if (input === "[") return { type: "sectionPrevious" };
    if (input === "g") {
      return state.pendingG ? { type: "selectTop" } : { type: "setPendingG", pending: true };
    }
  }

  // Shared actions available from either view.
  if (input === "A") return { type: "toggleActivity" };
  if (input === "y") return { type: "copyIdentifier" };

  const command = normalModeKeys[input];
  if (command) return { type: "enterMode", kind: command };

  return state.pendingG ? { type: "setPendingG", pending: false } : { type: "none" };
}
