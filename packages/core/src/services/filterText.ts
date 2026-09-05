import { AppError, AppErrorCode } from "../errors.js";
import { listIssueFiltersSchema } from "../schemas/issue.js";
import type { ListIssueFilters } from "./issue.js";

/** Optional text input for the same structured filters used by every adapter. */
export function parseIssueFilterText(input: string): {
  filters: ListIssueFilters;
  clear: (keyof ListIssueFilters)[];
} {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) { token += char; escaped = false; }
    else if (char === "\\") escaped = true;
    else if (quote) { if (char === quote) quote = null; else token += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (token) tokens.push(token); token = ""; }
    else token += char;
  }
  if (quote || escaped) invalid("Close the quoted value or escape sequence.");
  if (token) tokens.push(token);
  const filters: Record<string, unknown> = {};
  const clear: (keyof ListIssueFilters)[] = [];
  for (const part of tokens) {
    if (part === "unassigned") { filters.assignee = null; continue; }
    if (part === "no-project") { filters.project = null; continue; }
    if (part === "archived") { filters.includeArchived = true; continue; }
    const match = /^([^=:]+)[=:](.+)$/.exec(part);
    if (!match) invalid(`Expected field=value; quote multiword values, e.g. state="In Progress". Got: ${part}`);
    const key = match[1]!;
    const value = match[2]!;
    if (!["state", "assignee", "project", "label", "priority", "cycle", "team", "includeArchived"].includes(key)) {
      invalid(`Unknown filter "${key}". Use state, assignee, project, label, priority, cycle, team, or includeArchived.`);
    }
    if (key === "team" && value === "all") { clear.push("team"); continue; }
    if (key === "priority") {
      if (!/^[0-4]$/.test(value)) invalid("Priority must be an integer from 0 (none) to 4 (low).");
      filters.priority = Number(value);
    } else if (key === "includeArchived") {
      if (!["true", "false"].includes(value)) invalid("includeArchived must be true or false.");
      filters.includeArchived = value === "true";
    } else if (key === "assignee") filters.assignee = value === "unassigned" ? null : value.replace(/^@/, "");
    else if (key === "project") filters.project = value === "none" ? null : value;
    else if (key === "cycle") filters.cycle = /^\d+$/.test(value) ? Number(value) : value;
    else filters[key] = value;
  }
  return { filters: listIssueFiltersSchema.parse(filters), clear };
}

function invalid(message: string): never {
  throw new AppError(AppErrorCode.VALIDATION_FAILED, message);
}
