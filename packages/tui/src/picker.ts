import { getTeamByKey, type ListIssueFilters, type ServiceContext, type Team } from "@issue-tracker/core";
import type { LinekeeperData } from "./data.js";
import { priorityLabel } from "./format.js";

export interface PickerOption {
  id: string;
  label: string;
  value?: string | number | boolean | null;
  description?: string;
}
export const filterFields: PickerOption[] = [
  { id: "state", label: "Status" }, { id: "assignee", label: "Assignee" },
  { id: "project", label: "Project" }, { id: "label", label: "Label" },
  { id: "priority", label: "Priority" }, { id: "cycle", label: "Cycle" },
  { id: "team", label: "Team" }, { id: "includeArchived", label: "Archive scope" },
  { id: "clear", label: "Clear all filters" }, { id: "advanced", label: "Advanced text filters" }
];

export function filterValues(field: keyof ListIssueFilters, data: LinekeeperData, context: ServiceContext): PickerOption[] {
  const remove: PickerOption = { id: "remove", label: field === "team" ? "All teams" : "Remove this filter" };
  const team = activeTeam(data, context);
  switch (field) {
    case "state": return [remove, ...data.states.filter(s => !team || s.teamId === team.id).map(s => ({ id: s.id, value: s.id, label: `${s.name} (${data.teams.find(t => t.id === s.teamId)?.key ?? ""})` }))];
    case "assignee": return [remove, ...(context.actor?.type === "human" ? [{ id: "me", value: context.actor.id, label: "Me" }] : []), { id: "unassigned", value: null, label: "Unassigned" }, ...data.actors.map(a => ({ id: a.id, value: a.id, label: `${a.name} (@${a.handle})` }))];
    case "project": return [remove, { id: "none", value: null, label: "No project" }, ...data.projects.map(p => ({ id: p.id, value: p.id, label: p.name }))];
    // Core matches labels by name (issueIdsForLabelName), unlike the id-or-name
    // lookups behind state/assignee/project/cycle — so send the name, not the id.
    case "label": return [remove, ...data.labels.map(l => ({ id: l.id, value: l.name, label: l.name }))];
    case "priority": return [remove, ...[0, 1, 2, 3, 4].map(p => ({ id: String(p), value: p, label: priorityLabel(p) }))];
    case "cycle": return [remove, ...data.cycles.map(c => ({ id: c.id, value: c.id, label: `${c.name ?? "Cycle"} #${c.number} (${data.teams.find(t => t.id === c.teamId)?.key ?? ""})` }))];
    case "team": return [remove, ...data.teams.map(t => ({ id: t.id, value: t.key, label: `${t.name} (${t.key})` }))];
    case "includeArchived": return [remove, { id: "include", value: true, label: "Include archived" }, { id: "exclude", value: false, label: "Non-archived only" }];
    default: return [remove];
  }
}

export function searchPickerOptions(options: PickerOption[], query: string): PickerOption[] {
  const needle = query.trim().toLocaleLowerCase();
  return options.filter(option => `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(needle));
}

// The team filter holds whatever the user or a saved view supplied — an id, or
// a key in any case. Core canonicalizes keys (team=eng resolves to ENG), so ask
// core rather than comparing the raw value against team.key: a mismatch would
// silently offer every team's states under a single-team scope.
function activeTeam(data: LinekeeperData, context: ServiceContext): Team | null {
  const ref = data.filters.team;
  if (!ref) return null;
  const byId = data.teams.find(team => team.id === ref);
  if (byId) return byId;
  try { return getTeamByKey(context, ref); } catch { return null; }
}
