import { listIssueFiltersSchema } from "../schemas/issue.js";
import { parseIssueFilterText } from "./filterText.js";
import type { ListIssueFilters } from "./issue.js";

/**
 * Scope handed to a frontend for one launch: a saved/builtin view, filter text in the
 * shared `field=value` grammar, structured filters, and a search. Every adapter (the CLI's
 * `tracker tui`, or any other caller of the TUI startup API) passes its parsed input here
 * so the same rules decide what the launch scope is.
 */
export interface StartupScopeInput {
  search?: string;
  view?: string;
  filterText?: string;
  filters?: ListIssueFilters;
}

/** Resolved launch scope: `view: null` means "no view", `team: null` means all teams. */
export interface StartupScope {
  view: string | null;
  team?: string | null;
  search?: string;
  filters: ListIssueFilters;
}

/**
 * True when the input asks for a scope of its own rather than the remembered one. A team
 * on its own is not a scope: it is the frontend's default team, which the remembered-view
 * path already honours, so `--team` alone must still restore the last selected view.
 */
export function isExplicitStartupScope(input: StartupScopeInput | undefined): boolean {
  if (!input) return false;
  if (input.search !== undefined || input.view !== undefined || input.filterText !== undefined) return true;
  return Object.entries(input.filters ?? {}).some(([key, value]) => key !== "team" && value !== undefined);
}

/**
 * Turn launch input into one resolved scope, or null when nothing explicit was given so the
 * caller restores the remembered view. `view` supplies the base filters (resolved by the
 * list service), `filterText` merges on top through the same grammar as interactive filter
 * prompts, named `filters` override the same key from the text, and `search` runs within
 * the result. Team: a named team wins; `team=all` in the text clears it; a view alone drops
 * the default team (as `issue list --view` does); otherwise the default team applies,
 * exactly as an interactive search would keep it.
 */
export function resolveStartupScope(
  input: StartupScopeInput | undefined,
  defaultTeam?: string
): StartupScope | null {
  if (!input || !isExplicitStartupScope(input)) return null;
  const parsed = input.filterText ? parseIssueFilterText(input.filterText) : { filters: {}, clear: [] };
  const named = Object.fromEntries(
    Object.entries(input.filters ?? {}).filter(([, value]) => value !== undefined)
  ) as ListIssueFilters;
  const merged: Record<string, unknown> = { ...parsed.filters, ...named };
  for (const key of parsed.clear) {
    if (!(key in named)) delete merged[key];
  }
  const filters = listIssueFiltersSchema.parse(merged);
  const team = named.team !== undefined
    ? named.team
    : parsed.clear.includes("team")
      ? null
      : input.view
        ? undefined
        : defaultTeam;
  const scope: StartupScope = { view: input.view ?? null, filters };
  if (team !== undefined) scope.team = team;
  if (input.search !== undefined) scope.search = input.search;
  return scope;
}
