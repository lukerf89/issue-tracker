import {
  addAttachment,
  addComment,
  assignIssue,
  assignIssueInputSchema,
  createIssue,
  listActivitySince,
  listActors,
  listLabels,
  parseIssueFilterText,
  listCycles,
  listIssuesPageWithView,
  resolveIssueListFilters,
  resolveSavedView,
  getSupervisorHealth,
  listProfiles,
  listRepositories,
  listRuns,
  listProjects,
  listSavedViews,
  listStates,
  listTeams,
  moveIssue,
  searchIssuesPage,
  updateIssue,
  addCommentInputSchema,
  createIssueInputSchema,
  linkIssueInputSchema,
  listIssueFiltersSchema,
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
  team?: string | null;
  // Once edited, filters contain the complete effective query, including inherited values.
  materialized?: boolean;
  view?: string | null;
  search?: string | null;
  filters?: ListIssueFilters;
  limit?: number;
  cursor?: string;
}

export interface LinekeeperData {
  issues: IssueWithDetails[];
  nextCursor: string | null;
  // Per-issue bm25 excerpt, keyed by issue id. Populated only on the search
  // path; empty for plain lists/filters. TUI-only display concern — kept off
  // core's shared IssueWithDetails.
  snippets: Map<string, string>;
  teams: Team[];
  states: WorkflowState[];
  actors: Actor[];
  labels: ReturnType<typeof listLabels>;
  projects: Project[];
  cycles: Cycle[];
  savedViews: SavedViewWithFilters[];
  activity: ActivityFeedEvent[];
  activeTeamKey: string | null;
  activeView: string | null;
  modifiedView: boolean;
  search: string | null;
  filters: ListIssueFilters;
  runs: ReturnType<typeof listRuns>;
  repositories: ReturnType<typeof listRepositories>;
  profiles: ReturnType<typeof listProfiles>;
  supervisor: ReturnType<typeof getSupervisorHealth>;
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
  kind: "search" | "filter" | "view" | "runResponse";
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
  const view = cleanInput(options.view);
  const explicit = listIssueFiltersSchema.parse(omitUndefined({
    ...(options.filters ?? {}),
    team: options.team === null ? undefined : options.filters?.team ?? options.team
  }));
  const filters = resolveIssueListFilters(context, {
    view: options.materialized ? undefined : view ?? undefined,
    filters: explicit
  });
  if (options.team === null) delete filters.team;
  const search = cleanInput(options.search);
  const base = view ? resolveSavedView(context, view) : {};
  const modifiedView = !!view && (search !== null ||
    Object.keys({ ...base, ...filters }).some(key =>
      base[key as keyof ListIssueFilters] !== filters[key as keyof ListIssueFilters]));
  const queryFilters = { ...filters, limit: options.limit ?? filters.limit ?? 100 };
  const page = search
    ? searchIssuesPage(context, searchInputSchema.parse({ ...queryFilters, query: search }),
        { fields: ["labels"], cursor: options.cursor })
    : listIssuesPageWithView(context, { filters: queryFilters, fields: ["labels"], cursor: options.cursor });
  const issues = page.rows.map(row => row.issue as IssueWithDetails);
  const snippets = new Map<string, string>();
  for (const row of page.rows) {
    if (row.snippet) snippets.set(row.issue.id, row.snippet);
  }
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
    nextCursor: page.nextCursor,
    snippets,
    teams,
    states,
    actors: listActors(context),
    labels: listLabels(context),
    projects: listProjects(context),
    cycles: listCycles(context, filters.team ? { team: filters.team } : {}),
    savedViews: listSavedViews(context),
    activity,
    activeTeamKey: filters.team ?? null,
    activeView: view,
    modifiedView,
    search,
    filters
    ,runs: listRuns(context)
    ,repositories: listRepositories(context)
    ,profiles: listProfiles(context)
    ,supervisor: getSupervisorHealth(context)
  };
}


// Fetch before replacing the usable list; callers can show an error and retry.
export function loadMoreLinekeeperData(
  context: ServiceContext,
  data: LinekeeperData,
  limit = 100
): LinekeeperData {
  if (!data.nextCursor) return data;
  const page = loadLinekeeperData(context, {
    ...effectiveLoadOptions(data), cursor: data.nextCursor, limit
  });
  const known = new Set(data.issues.map(issue => issue.id));
  return {
    ...page,
    issues: [...data.issues, ...page.issues.filter(issue => !known.has(issue.id))],
    snippets: new Map([...data.snippets, ...page.snippets])
  };
}

// A view is resolved on selection; subsequent edits operate on the visible query.
export function effectiveLoadOptions(data: LinekeeperData): LinekeeperLoadOptions {
  return { view: data.activeView, search: data.search, filters: data.filters, materialized: true };
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
    case "runResponse":
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
  return parseIssueFilterText(input).filters;
}

// Return a copy of the filters with a single key removed (re-parsed to keep the
// canonical shape). Used to peel off one active filter chip; clearing the last
// key yields empty filters.
export function removeFilterKey(
  filters: ListIssueFilters | undefined,
  key: keyof ListIssueFilters
): ListIssueFilters {
  const next: Record<string, unknown> = { ...(filters ?? {}) };
  delete next[key];
  return listIssueFiltersSchema.parse(next);
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
