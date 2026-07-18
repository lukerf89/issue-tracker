export type LinekeeperFocus = "list" | "detail";

export type LinekeeperSection = "metadata" | "runs" | "subIssues" | "description" | "comments";

export const linekeeperSections: LinekeeperSection[] = [
  "metadata",
  "runs",
  "subIssues",
  "description",
  "comments"
];

export type LinekeeperCommandKind =
  | "search"
  | "filter"
  | "view"
  | "new"
  | "move"
  | "priority"
  | "assign"
  | "labels"
  | "comment"
  | "subIssue"
  | "link"
  | "runResponse";

export interface LinekeeperCommandMode {
  kind: LinekeeperCommandKind;
  input: string;
}

export interface LinekeeperUiState {
  selectedIndex: number;
  focus: LinekeeperFocus;
  sectionIndex: number;
  detailScroll: number;
  activityExpanded: boolean;
  pendingG: boolean;
  mode: LinekeeperCommandMode | null;
  statusMessage: string | null;
}

export type LinekeeperAction =
  | { type: "moveSelection"; delta: number }
  | { type: "selectTop" }
  | { type: "selectBottom" }
  | { type: "focusNext" }
  | { type: "focusPrevious" }
  | { type: "sectionNext" }
  | { type: "sectionPrevious" }
  | { type: "scrollDetail"; delta: number }
  | { type: "resetDetailScroll" }
  | { type: "toggleActivity" }
  | { type: "enterMode"; kind: LinekeeperCommandKind; seed?: string }
  | { type: "appendModeInput"; value: string }
  | { type: "backspaceModeInput" }
  | { type: "cancelMode" }
  | { type: "submitMode" }
  | { type: "setStatus"; message: string | null }
  | { type: "setPendingG"; pending: boolean }
  | { type: "clampSelection" };

export function initialLinekeeperState(): LinekeeperUiState {
  return {
    selectedIndex: 0,
    focus: "list",
    sectionIndex: 0,
    detailScroll: 0,
    activityExpanded: false,
    pendingG: false,
    mode: null,
    statusMessage: null
  };
}

export function reduceLinekeeperState(
  state: LinekeeperUiState,
  action: LinekeeperAction,
  issueCount: number
): LinekeeperUiState {
  const maxIndex = Math.max(0, issueCount - 1);

  switch (action.type) {
    case "moveSelection":
      return {
        ...state,
        selectedIndex: clamp(state.selectedIndex + action.delta, 0, maxIndex),
        detailScroll: 0,
        pendingG: false
      };
    case "selectTop":
      return { ...state, selectedIndex: 0, detailScroll: 0, pendingG: false };
    case "selectBottom":
      return { ...state, selectedIndex: maxIndex, detailScroll: 0, pendingG: false };
    case "focusNext":
      return {
        ...state,
        focus: state.focus === "list" ? "detail" : "list",
        detailScroll: 0,
        pendingG: false
      };
    case "focusPrevious":
      return {
        ...state,
        focus: state.focus === "detail" ? "list" : "detail",
        detailScroll: 0,
        pendingG: false
      };
    case "sectionNext":
      return {
        ...state,
        focus: "detail",
        sectionIndex: clamp(state.sectionIndex + 1, 0, linekeeperSections.length - 1),
        pendingG: false
      };
    case "sectionPrevious":
      return {
        ...state,
        focus: "detail",
        sectionIndex: clamp(state.sectionIndex - 1, 0, linekeeperSections.length - 1),
        pendingG: false
      };
    case "scrollDetail":
      return {
        ...state,
        focus: "detail",
        detailScroll: Math.max(0, state.detailScroll + action.delta),
        pendingG: false
      };
    case "resetDetailScroll":
      return { ...state, detailScroll: 0, pendingG: false };
    case "toggleActivity":
      return {
        ...state,
        activityExpanded: !state.activityExpanded,
        pendingG: false
      };
    case "enterMode":
      return {
        ...state,
        mode: { kind: action.kind, input: action.seed ?? "" },
        statusMessage: null,
        pendingG: false
      };
    case "appendModeInput":
      return state.mode
        ? {
            ...state,
            mode: { ...state.mode, input: state.mode.input + action.value },
            pendingG: false
          }
        : { ...state, pendingG: false };
    case "backspaceModeInput":
      return state.mode
        ? {
            ...state,
            mode: { ...state.mode, input: state.mode.input.slice(0, -1) },
            pendingG: false
          }
        : { ...state, pendingG: false };
    case "cancelMode":
      return { ...state, mode: null, pendingG: false };
    case "submitMode":
      return { ...state, mode: null, pendingG: false };
    case "setStatus":
      return { ...state, statusMessage: action.message, pendingG: false };
    case "setPendingG":
      return { ...state, pendingG: action.pending };
    case "clampSelection":
      return {
        ...state,
        selectedIndex: clamp(state.selectedIndex, 0, maxIndex),
        detailScroll: 0,
        pendingG: false
      };
  }
}

export function selectedSection(state: LinekeeperUiState): LinekeeperSection {
  return linekeeperSections[clamp(state.sectionIndex, 0, linekeeperSections.length - 1)] ?? "metadata";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
