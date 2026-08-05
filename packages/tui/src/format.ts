import type {
  ActivityFeedEvent,
  Actor,
  Cycle,
  IssueWithDetails,
  ListIssueFilters,
  Project,
  WorkflowState
} from "@issue-tracker/core";

import type { LinekeeperData } from "./data.js";

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `${value.slice(0, width - 3)}...`;
}

export function padColumn(value: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncate(value, width);
  return clipped.padEnd(width, " ");
}

export function priorityLabel(priority: number): string {
  switch (priority) {
    case 1:
      return "Urgent";
    case 2:
      return "High";
    case 3:
      return "Medium";
    case 4:
      return "Low";
    default:
      return "No priority";
  }
}

export function formatActor(actor: Actor | null | undefined): string {
  if (!actor) return "unassigned";
  return actor.type === "agent" ? `@${actor.handle} [agent]` : `@${actor.handle}`;
}

export function shortActor(actor: Actor | null | undefined): string {
  return actor ? `@${actor.handle}` : "unassigned";
}

export function issueState(data: LinekeeperData, issue: IssueWithDetails): WorkflowState | null {
  return data.states.find((state) => state.id === issue.stateId) ?? null;
}

export function issueAssignee(data: LinekeeperData, issue: IssueWithDetails): Actor | null {
  return issue.assigneeId
    ? data.actors.find((actor) => actor.id === issue.assigneeId) ?? null
    : null;
}

export function issueCreator(data: LinekeeperData, issue: IssueWithDetails): Actor | null {
  return data.actors.find((actor) => actor.id === issue.creatorId) ?? null;
}

export function issueProject(data: LinekeeperData, issue: IssueWithDetails): Project | null {
  return issue.projectId
    ? data.projects.find((project) => project.id === issue.projectId) ?? null
    : null;
}

export function issueCycle(data: LinekeeperData, issue: IssueWithDetails): Cycle | null {
  return issue.cycleId
    ? data.cycles.find((cycle) => cycle.id === issue.cycleId) ?? null
    : null;
}

// A single active-filter (or active-search) chip. `key` identifies what to drop
// on remove-one: a ListIssueFilters key, or "search" to clear the search.
export interface FilterChip {
  key: keyof ListIssueFilters | "search";
  label: string;
}

// Build the ordered chip list for the active filters + search. Labels echo the
// stored (human-entered) filter values, defensively resolving an id to a name
// when the stored value happens to be one. `team`/`limit` are excluded: team is
// already in the header and limit is not user-facing.
export function buildFilterChips(data: LinekeeperData): FilterChip[] {
  const filters = data.filters ?? {};
  const chips: FilterChip[] = [];

  if (filters.state !== undefined) {
    const resolved = data.states.find((state) => state.id === filters.state)?.name;
    chips.push({ key: "state", label: `state=${resolved ?? filters.state}` });
  }

  if (filters.assignee !== undefined) {
    if (filters.assignee === null) {
      chips.push({ key: "assignee", label: "unassigned" });
    } else {
      const handle = data.actors.find((actor) => actor.id === filters.assignee)?.handle;
      chips.push({ key: "assignee", label: `@${handle ?? filters.assignee}` });
    }
  }

  if (filters.priority !== undefined) {
    chips.push({ key: "priority", label: `priority:${priorityLabel(filters.priority)}` });
  }

  if (filters.project !== undefined) {
    if (filters.project === null) {
      chips.push({ key: "project", label: "no-project" });
    } else {
      const resolved = data.projects.find((project) => project.id === filters.project)?.name;
      chips.push({ key: "project", label: `project:${resolved ?? filters.project}` });
    }
  }

  if (filters.label !== undefined) {
    chips.push({ key: "label", label: `label:${filters.label}` });
  }

  if (filters.cycle !== undefined) {
    // A cycle filter is stored as either the cycle number (e.g. 3) or an id;
    // resolve against both so a numeric filter shows the cycle's name.
    const match = data.cycles.find(
      (cycle) => cycle.id === filters.cycle || cycle.number === filters.cycle
    );
    const resolved = match ? match.name ?? `Cycle ${match.number}` : String(filters.cycle);
    chips.push({ key: "cycle", label: `cycle:${resolved}` });
  }

  if (filters.includeArchived) {
    chips.push({ key: "includeArchived", label: "archived" });
  }

  if (data.search) {
    chips.push({ key: "search", label: `/${data.search}` });
  }

  return chips;
}

export function childDoneMarker(data: LinekeeperData, childId: string): string {
  const child = data.issues.find((issue) => issue.id === childId);
  const state = child ? issueState(data, child) : null;
  return state?.type === "completed" ? "[x]" : "[ ]";
}

export function lastAgentActivity(
  data: LinekeeperData,
  issue: IssueWithDetails
): ActivityFeedEvent | null {
  for (const event of [...data.activity].reverse()) {
    if (event.issue.id === issue.id && event.actor.type === "agent") {
      return event;
    }
  }

  return null;
}

export function formatLastAgentActivity(
  data: LinekeeperData,
  issue: IssueWithDetails
): string | null {
  const event = lastAgentActivity(data, issue);
  if (!event) return null;
  return `agent: ${activitySummary(event)}`;
}

export function formatActivityEvent(event: ActivityFeedEvent): string {
  return `${formatTime(event.createdAt)} ${event.actor.handle} ${event.issueIdentifier} ${activitySummary(event)}`;
}

export function activitySummary(event: ActivityFeedEvent): string {
  const data = activityData(event.data);

  if (event.action === "state_changed") {
    const fromName = stringData(data, "fromName");
    const toName = stringData(data, "toName");
    if (fromName && toName) return `state_changed ${fromName} -> ${toName}`;
  }

  if (event.action === "assigned") {
    const toHandle = stringData(data, "toHandle");
    return toHandle ? `assigned @${toHandle}` : "assigned unassigned";
  }

  if (event.action === "linked") {
    const kind = stringData(data, "kind") ?? "attachment";
    const title = stringData(data, "title");
    return title ? `${kind} ${title}` : kind;
  }

  return event.action;
}

export function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString().slice(11, 16);
}

function stringData(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function activityData(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}
