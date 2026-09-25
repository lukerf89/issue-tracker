import type { ListIssueFilters } from "@issue-tracker/core";
import { type Command, InvalidArgumentError } from "commander";

/**
 * One CLI flag for a `ListIssueFilters` key. `nullAlias` is the boolean flag that sends an
 * explicit `null` (MCP `assignee: null` ↔ CLI `--unassigned`), or `false` for `ready`.
 */
export interface FilterOptionSpec {
  readonly flags: string;
  readonly description: string;
  readonly parser?: (value: string) => unknown;
  readonly nullAlias?: { readonly flags: string; readonly description: string };
}

export function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value) {
    throw new InvalidArgumentError("expected an integer");
  }

  return parsed;
}

/**
 * Every core list filter must have an explicit CLI decision: typing this as a Record over
 * `keyof ListIssueFilters` makes a new core filter without a CLI flag a typecheck error.
 * `query` is null because each command spells it differently (list `--query`, search
 * positional `<query>`, view save `--query` as saved search text).
 */
export const ISSUE_FILTER_OPTIONS: Readonly<Record<keyof ListIssueFilters, FilterOptionSpec | null>> = {
  query: null,
  stateTypes: { flags: "--state-types <types>", description: "comma-separated workflow types" },
  ready: {
    flags: "--ready",
    description: "only ready backlog/unstarted work",
    nullAlias: { flags: "--not-ready", description: "only work that is not ready" }
  },
  parent: {
    flags: "--parent <issue>",
    description: "parent issue identifier or ID",
    nullAlias: { flags: "--no-parent", description: "only issues without a parent" }
  },
  blockedBy: { flags: "--blocked-by <issue>", description: "issues blocked by this issue" },
  blocks: { flags: "--blocks <issue>", description: "issues blocking this issue" },
  repository: { flags: "--repository <repository>", description: "effective repository ID/name" },
  updatedSince: { flags: "--updated-since <timestamp>", description: "inclusive ISO timestamp" },
  dueFrom: { flags: "--due-from <date>", description: "inclusive due date YYYY-MM-DD" },
  dueTo: { flags: "--due-to <date>", description: "inclusive due date YYYY-MM-DD" },
  sort: { flags: "--sort <field>", description: "identifier, priority, or updatedAt" },
  state: { flags: "--state <state>", description: "workflow state" },
  assignee: {
    flags: "--assignee <actor>",
    description: "assignee id or handle",
    nullAlias: { flags: "--unassigned", description: "only unassigned issues" }
  },
  project: {
    flags: "--project <project>",
    description: "project id or name",
    nullAlias: { flags: "--no-project", description: "only issues without a project" }
  },
  cycle: { flags: "--cycle <cycle>", description: "cycle number or id" },
  label: { flags: "--label <label>", description: "label name" },
  priority: { flags: "--priority <number>", description: "priority", parser: parseInteger },
  team: { flags: "--team <key>", description: "team key" },
  limit: { flags: "--limit <number>", description: "maximum number of issues per page", parser: parseInteger },
  includeArchived: { flags: "--include-archived", description: "include archived issues" }
};

type FilterKey = keyof ListIssueFilters;
const ALL_FILTER_KEYS = Object.keys(ISSUE_FILTER_OPTIONS) as FilterKey[];

/** `issue list`: every filter as a flag; `query` is added by the command as `--query`. */
export const LIST_FILTER_KEYS: readonly FilterKey[] = ALL_FILTER_KEYS.filter((key) => key !== "query");
/** `issue search`: the list filters; `query` is the `<query>` positional. No `--view`. */
export const SEARCH_FILTER_KEYS: readonly FilterKey[] = LIST_FILTER_KEYS;
/** `view save`: everything but `limit` (a view stores filters, not a page size). */
export const VIEW_SAVE_FILTER_KEYS: readonly FilterKey[] = ALL_FILTER_KEYS.filter(
  (key) => key !== "query" && key !== "limit"
);

/**
 * `tracker tui`: the launch-scope subset — the filters the TUI's `:` picker edits, so
 * `--search`/`--view`/`--filter` plus these flags start the UI in a scope typed at the shell.
 */
export const TUI_FILTER_KEYS: readonly FilterKey[] = ["team", "project", "state", "assignee", "label", "priority"];

/** Value flag name → its null-alias flag name, for mutual-exclusion checks. */
const ALIAS_PAIRS: ReadonlyArray<readonly [string, string]> = ALL_FILTER_KEYS.flatMap((key) => {
  const spec = ISSUE_FILTER_OPTIONS[key];
  return spec?.nullAlias ? [[flagName(spec.flags), flagName(spec.nullAlias.flags)] as const] : [];
});

const seenFlags = new WeakMap<Command, Set<string>>();

/**
 * Registers the subset's filter flags with the same names, descriptions and parsers on
 * every command, records which alias spellings were used, and rejects conflicting pairs
 * before the action runs.
 */
export function addIssueFilterOptions(command: Command, keys: readonly FilterKey[]): Command {
  const seen = new Set<string>();
  seenFlags.set(command, seen);
  for (const key of keys) {
    const spec = ISSUE_FILTER_OPTIONS[key];
    if (!spec) continue;
    if (spec.parser) command.option(spec.flags, spec.description, spec.parser);
    else command.option(spec.flags, spec.description);
    if (spec.nullAlias) {
      command.option(spec.nullAlias.flags, spec.nullAlias.description);
      // Commander stores `--project` and `--no-project` under ONE attribute (last flag
      // wins), so parsed options cannot reveal a conflict. Per-option events can.
      for (const name of [flagName(spec.flags), flagName(spec.nullAlias.flags)]) {
        command.on(`option:${name}`, () => seen.add(name));
      }
    }
  }
  command.hook("preAction", (_thisCommand, actionCommand) => assertNoFilterAliasConflicts(actionCommand));
  return command;
}

/** Throws a commander validation error when a flag and its null alias were both given. */
export function assertNoFilterAliasConflicts(command: Command): void {
  const seen = seenFlags.get(command);
  if (!seen) return;
  try {
    for (const [value, alias] of ALIAS_PAIRS) {
      if (seen.has(value) && seen.has(alias)) {
        throw new InvalidArgumentError(`choose --${value} or --${alias}`);
      }
    }
  } finally {
    seen.clear();
  }
}

function flagName(flags: string): string {
  return flags.split(/[ ,]/)[0]!.replace(/^--/, "");
}
