export type IssueListShortcutAction =
  | "none"
  | "openCreate"
  | "selectNext"
  | "selectPrevious"
  | "openSelected"
  | "focusSearch"
  | "goBoard"
  | "goList"
  | "closeCreate"
  | "clearSelection";

export interface IssueListShortcutResult {
  action: IssueListShortcutAction;
  pendingGo: boolean;
}

export interface IssueListShortcutState {
  createOpen: boolean;
  hasSelection: boolean;
  pendingGo: boolean;
}

export interface ShortcutKeyEvent {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: EventTarget | null;
}

export function issueListShortcutForEvent(
  event: ShortcutKeyEvent,
  state: IssueListShortcutState
): IssueListShortcutResult {
  const key = normalizedShortcutKey(event.key);

  if (event.altKey || event.ctrlKey || event.metaKey) {
    return noAction(state.pendingGo);
  }

  if (key === "Escape") {
    if (state.createOpen) return action("closeCreate", false);
    if (!isShortcutTypingTarget(event.target ?? null) && state.hasSelection) {
      return action("clearSelection", false);
    }

    return noAction(false);
  }

  if (state.createOpen) {
    return noAction(false);
  }

  if (isShortcutTypingTarget(event.target ?? null)) {
    return noAction(false);
  }

  if (state.pendingGo) {
    if (key === "b") return action("goBoard", false);
    if (key === "l") return action("goList", false);
    if (key === "g") return noAction(true);

    return noAction(false);
  }

  if (key === "c") return action("openCreate", false);
  if (key === "j") return action("selectNext", false);
  if (key === "k") return action("selectPrevious", false);
  if (key === "Enter" && state.hasSelection) return action("openSelected", false);
  if (key === "/") return action("focusSearch", false);
  if (key === "g") return noAction(true);

  return noAction(false);
}

export function nextSelectionIndex(
  currentIndex: number | null,
  direction: "next" | "previous",
  issueCount: number
): number | null {
  if (issueCount <= 0) return null;

  if (currentIndex === null) {
    return direction === "next" ? 0 : issueCount - 1;
  }

  if (direction === "next") {
    return Math.min(currentIndex + 1, issueCount - 1);
  }

  return Math.max(currentIndex - 1, 0);
}

export function isShortcutTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();

  if (tagName === "textarea" || tagName === "select") {
    return true;
  }

  if (tagName !== "input") {
    return false;
  }

  const input = target as HTMLInputElement;
  return !["button", "checkbox", "radio", "reset", "submit"].includes(input.type);
}

function normalizedShortcutKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function action(actionName: IssueListShortcutAction, pendingGo: boolean): IssueListShortcutResult {
  return { action: actionName, pendingGo };
}

function noAction(pendingGo: boolean): IssueListShortcutResult {
  return action("none", pendingGo);
}
