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
}

export type LinekeeperKeyAction =
  | LinekeeperAction
  | { type: "quit" }
  | { type: "copyIdentifier" }
  | { type: "openSelected" }
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
  if (key.return) return { type: "openSelected" };
  if (input === "j") return { type: "moveSelection", delta: 1 };
  if (input === "k") return { type: "moveSelection", delta: -1 };
  if (input === "G") return { type: "selectBottom" };
  if (input === "]") return { type: "sectionNext" };
  if (input === "[") return { type: "sectionPrevious" };
  if (input === "A") return { type: "toggleActivity" };
  if (input === "y") return { type: "copyIdentifier" };

  if (input === "g") {
    return state.pendingG ? { type: "selectTop" } : { type: "setPendingG", pending: true };
  }

  const command = normalModeKeys[input];
  if (command) return { type: "enterMode", kind: command };

  return state.pendingG ? { type: "setPendingG", pending: false } : { type: "none" };
}
