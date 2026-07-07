import {
  addAttachment,
  addComment,
  assignIssue,
  assignIssueInputSchema,
  createIssue,
  listActivitySince,
  listActors,
  listCycles,
  listIssuesWithView,
  listProjects,
  listSavedViews,
  listStates,
  listTeams,
  moveIssue,
  searchIssues,
  updateIssue,
  addCommentInputSchema,
  createIssueInputSchema,
  linkIssueInputSchema,
  listIssueFiltersSchema,
  listIssuesWithViewInputSchema,
  moveIssueInputSchema,
  searchInputSchema,
  updateIssueInputSchema,
  type ActivityFeedEvent,
  type Actor,
  type AddAttachmentInput,
  type Cycle,
  type IssueWithDetails,
  type ListIssueFilters,
  type Project,
  type SavedViewWithFilters,
  type ServiceContext,
  type Team,
  type WorkflowState
} from "@issue-tracker/core";

import type { LinekeeperCommandMode } from "./state.js";

export interface LinekeeperLoadOptions {
  team?: string;
  view?: string | null;
  search?: string | null;
  filters?: ListIssueFilters;
  limit?: number;
}

export interface LinekeeperData {
  issues: IssueWithDetails[];
  teams: Team[];
  states: WorkflowState[];
  actors: Actor[];
  projects: Project[];
  cycles: Cycle[];
  savedViews: SavedViewWithFilters[];
  activity: ActivityFeedEvent[];
  activeTeamKey: string | null;
  activeView: string | null;
  search: string | null;
  filters: ListIssueFilters;
}

export type LinekeeperCoreCommand =
  | { kind: "new"; title: string; team?: string }
  | { kind: "move"; issueIdentifier: string; state: string }
  | { kind: "priority"; issueIdentifier: string; priority: number }
  | { kind: "assign"; issueIdentifier: string; actor: string | null }
  | { kind: "labels"; issueIdentifier: string; labels: string[] }
  | { kind: "comment"; issueIdentifier: string; body: string }
  | { kind: "subIssue"; parentIdentifier: string; title: string; team?: string }
  | { kind: "link"; input: AddAttachmentInput };

export interface LinekeeperReadCommand {
  kind: "search" | "filter" | "view";
  input: string;
}

export type LinekeeperCommand = LinekeeperCoreCommand | LinekeeperReadCommand;

export interface LinekeeperCommandResult {
  message: string;
  issueIdentifier?: string;
}

export function loadLinekeeperData(
  context: ServiceContext,
  options: LinekeeperLoadOptions = {}
): LinekeeperData {
  const filters = listIssueFiltersSchema.parse(omitUndefined({
    ...(options.filters ?? {}),
    team: options.team ?? options.filters?.team,
    limit: options.limit ?? options.filters?.limit ?? 100
  }));
  const search = cleanInput(options.search);
  const view = cleanInput(options.view);
  const issues = search
    ? searchIssues(context, searchInputSchema.parse({ ...filters, query: search }))
    : listIssuesWithView(
        context,
        listIssuesWithViewInputSchema.parse({
          view: view ?? undefined,
          filters
        })
      );
  const teams = listTeams(context);
  const teamIds = new Set<string>([
    ...teams.map((team) => team.id),
    ...issues.map((issue) => issue.teamId)
  ]);
  const states = [...teamIds].flatMap((teamId) => listStates(context, teamId));
  const activity = listActivitySince(context, {
    team: filters.team,
    limit: 100
  }).events;

  return {
    issues,
    teams,
    states,
    actors: listActors(context),
    projects: listProjects(context),
    cycles: listCycles(context, filters.team ? { team: filters.team } : {}),
    savedViews: listSavedViews(context),
    activity,
    activeTeamKey: filters.team ?? null,
    activeView: view,
    search,
    filters
  };
}

export function commandFromMode(
  mode: LinekeeperCommandMode,
  selectedIssue: IssueWithDetails | null,
  defaultTeam?: string
): LinekeeperCommand {
  const input = mode.input.trim();

  switch (mode.kind) {
    case "search":
    case "filter":
    case "view":
      return { kind: mode.kind, input };
    case "new":
      assertInput(input, "New issue title is required.");
      createIssueInputSchema.parse(omitUndefined({ title: input, team: defaultTeam }));
      return { kind: "new", title: input, team: defaultTeam };
    case "move":
      return {
        kind: "move",
        issueIdentifier: moveIssueInputSchema.parse({
          identifier: requireIssue(selectedIssue).identifier,
          state: input
        }).identifier,
        state: input
      };
    case "priority":
      assertInput(input, "Priority is required.");
      return {
        kind: "priority",
        issueIdentifier: requireIssue(selectedIssue).identifier,
        priority: parsePriority(input)
      };
    case "assign":
      return {
        kind: "assign",
        issueIdentifier: requireIssue(selectedIssue).identifier,
        actor: parseAssignee(input)
      };
    case "labels":
      return {
        kind: "labels",
        issueIdentifier: requireIssue(selectedIssue).identifier,
        labels: parseLabels(input)
      };
    case "comment":
      return {
        kind: "comment",
        issueIdentifier: requireIssue(selectedIssue).identifier,
        body: input
      };
    case "subIssue":
      assertInput(input, "Sub-issue title is required.");
      createIssueInputSchema.parse(
        omitUndefined({
          title: input,
          parent: requireIssue(selectedIssue).identifier,
          team: defaultTeam
        })
      );
      return {
        kind: "subIssue",
        parentIdentifier: requireIssue(selectedIssue).identifier,
        title: input,
        team: defaultTeam
      };
    case "link":
      return {
        kind: "link",
        input: parseLinkInput(requireIssue(selectedIssue).identifier, input)
      };
  }
}

export function executeLinekeeperCommand(
  context: ServiceContext,
  command: LinekeeperCoreCommand
): LinekeeperCommandResult {
  switch (command.kind) {
    case "new": {
      const issue = createIssue(context, createIssueInputSchema.parse({
        title: command.title,
        team: command.team
      }));
      return { message: `Created ${issue.identifier}.`, issueIdentifier: issue.identifier };
    }
    case "move": {
      const input = moveIssueInputSchema.parse({
        identifier: command.issueIdentifier,
        state: command.state
      });
      const issue = moveIssue(context, input.identifier, input.state);
      return { message: `Moved ${issue.identifier}.`, issueIdentifier: issue.identifier };
    }
    case "priority": {
      const input = updateIssueInputSchema.parse({ priority: command.priority });
      const issue = updateIssue(context, command.issueIdentifier, input);
      return { message: `Updated ${issue.identifier} priority.`, issueIdentifier: issue.identifier };
    }
    case "assign": {
      const input = assignIssueInputSchema.parse({
        identifier: command.issueIdentifier,
        actor: command.actor
      });
      const issue = assignIssue(context, input.identifier, input.actor);
      return { message: `Assigned ${issue.identifier}.`, issueIdentifier: issue.identifier };
    }
    case "labels": {
      const input = updateIssueInputSchema.parse({ labels: command.labels });
      const issue = updateIssue(context, command.issueIdentifier, input);
      return { message: `Updated ${issue.identifier} labels.`, issueIdentifier: issue.identifier };
    }
    case "comment": {
      addComment(context, addCommentInputSchema.parse({
        issue: command.issueIdentifier,
        body: command.body
      }));
      return { message: `Commented on ${command.issueIdentifier}.`, issueIdentifier: command.issueIdentifier };
    }
    case "subIssue": {
      const issue = createIssue(
        context,
        createIssueInputSchema.parse({
          title: command.title,
          parent: command.parentIdentifier,
          team: command.team
        })
      );
      return { message: `Created ${issue.identifier}.`, issueIdentifier: issue.identifier };
    }
    case "link": {
      const attachment = addAttachment(context, linkIssueInputSchema.parse(command.input));
      return { message: `Linked ${attachment.title}.`, issueIdentifier: command.input.issue };
    }
  }
}

export function parseFilterInput(input: string): ListIssueFilters {
  const filters: Record<string, unknown> = {};
  const parts = input
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (part === "unassigned") {
      filters.assignee = null;
      continue;
    }

    if (part === "no-project") {
      filters.project = null;
      continue;
    }

    if (part === "archived") {
      filters.includeArchived = true;
      continue;
    }

    const separator = part.includes("=") ? "=" : ":";
    const [rawKey, ...rest] = part.split(separator);
    const key = rawKey?.trim();
    const value = rest.join(separator).trim();
    if (!key || !value) continue;

    if (key === "state") filters.state = value;
    if (key === "assignee") filters.assignee = normalizeHandle(value);
    if (key === "project") filters.project = value;
    if (key === "label") filters.label = value;
    if (key === "team") filters.team = value;
    if (key === "cycle") filters.cycle = /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
    if (key === "priority") filters.priority = Number.parseInt(value, 10);
  }

  return listIssueFiltersSchema.parse(filters);
}

function parsePriority(input: string): number {
  const normalized = input.toLowerCase();
  const named: Record<string, number> = {
    none: 0,
    urgent: 1,
    high: 2,
    medium: 3,
    low: 4
  };
  const priority = named[normalized] ?? Number.parseInt(normalized.replace(/^p/, ""), 10);
  return updateIssueInputSchema.parse({ priority }).priority ?? 0;
}

function parseAssignee(input: string): string | null {
  const normalized = input.trim();
  if (["", "none", "clear", "unassigned"].includes(normalized.toLowerCase())) return null;
  return normalizeHandle(normalized);
}

function normalizeHandle(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function parseLabels(input: string): string[] {
  const labels = input
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.length === 0) throw new Error("At least one label is required.");
  return labels;
}

function parseLinkInput(issue: string, input: string): AddAttachmentInput {
  assertInput(input, "Link or branch input is required.");
  const parts = input.split(/\s+/).filter(Boolean);

  if (parts[0] === "branch" && parts.length >= 3) {
    return linkIssueInputSchema.parse({
      issue,
      kind: "branch",
      repoPath: parts[1],
      branchName: parts.slice(2).join(" ")
    });
  }

  return linkIssueInputSchema.parse({
    issue,
    kind: "link",
    url: input
  });
}

function requireIssue(issue: IssueWithDetails | null): IssueWithDetails {
  if (!issue) throw new Error("Select an issue first.");
  return issue;
}

function assertInput(input: string, message: string): void {
  if (input.length === 0) throw new Error(message);
}

function cleanInput(input: string | null | undefined): string | null {
  const cleaned = input?.trim();
  return cleaned ? cleaned : null;
}

function omitUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  ) as T;
}
