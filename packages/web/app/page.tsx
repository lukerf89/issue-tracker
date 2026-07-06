import Link from "next/link";

import {
  getIssueListPageData,
  type IssueListPageData,
  type IssueListPageFilters
} from "../src/data/queries";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

interface IssueListPageProps {
  searchParams?: Promise<SearchParams>;
}

const unassignedValue = "__unassigned";
const noProjectValue = "__no_project";
const priorityOptions = [0, 1, 2, 3, 4];

const selectClassName =
  "mt-1 h-8 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-zinc-500";

export default async function IssueListPage({ searchParams }: IssueListPageProps = {}) {
  const filters = issueListFiltersFromSearchParams(searchParams ? await searchParams : {});

  try {
    const data = await getIssueListPageData(filters);
    const stateById = new Map(data.states.map((state) => [state.id, state]));
    const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));

    return (
      <div className="space-y-4">
        <section className="flex flex-col gap-3 border-b border-zinc-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-50">Issues</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Showing {data.issues.length} issue{data.issues.length === 1 ? "" : "s"}.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <Metric label="Projects" value={data.projects.length} />
            <Metric label="Labels" value={data.labels.length} />
            <Metric label="Teams" value={data.teams.length} />
          </div>
        </section>

        <FilterBar data={data} filters={filters} />

        <section className="overflow-hidden rounded-md border border-zinc-800">
          <div className="overflow-x-auto">
            <div className="min-w-[56rem]">
              <div className="grid grid-cols-[7rem_4rem_9rem_minmax(18rem,1fr)_10rem] gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium uppercase text-zinc-500">
                <span>Identifier</span>
                <span>Priority</span>
                <span>State</span>
                <span>Title</span>
                <span>Assignee</span>
              </div>
              <div className="divide-y divide-zinc-900">
                {data.issues.length > 0 ? (
                  data.issues.map((issue) => {
                    const state = stateById.get(issue.stateId);
                    const assignee = issue.assigneeId
                      ? actorById.get(issue.assigneeId)?.handle ?? "Unknown"
                      : "Unassigned";

                    return (
                      <Link
                        aria-label={`${issue.identifier} ${issue.title}`}
                        className="grid grid-cols-[7rem_4rem_9rem_minmax(18rem,1fr)_10rem] items-center gap-3 bg-zinc-950 px-3 py-2 text-sm hover:bg-zinc-900 focus:bg-zinc-900 focus:outline-none"
                        href={`/issues/${issue.identifier}`}
                        key={issue.id}
                      >
                        <span className="font-mono text-xs text-zinc-400">
                          {issue.identifier}
                        </span>
                        <span className="text-zinc-300">P{issue.priority}</span>
                        <StateCell color={state?.color} name={state?.name ?? "Unknown"} />
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-zinc-100">{issue.title}</span>
                          {issue.archivedAt ? (
                            <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[0.7rem] text-zinc-500">
                              Archived
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-zinc-400">{assignee}</span>
                      </Link>
                    );
                  })
                ) : (
                  <p className="bg-zinc-950 px-3 py-6 text-sm text-zinc-500">
                    No issues match these filters.
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  } catch (error) {
    return <SetupNotice error={error} />;
  }
}

function FilterBar({
  data,
  filters
}: {
  data: IssueListPageData;
  filters: IssueListPageFilters;
}) {
  const states = uniqueBy(data.states, (state) => state.name);
  const cycles = uniqueBy(data.cycles, (cycle) => String(cycle.number));

  return (
    <form
      action="/"
      className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-[repeat(6,minmax(0,1fr))_auto_auto]"
      method="get"
    >
      <label className="text-xs font-medium text-zinc-500">
        State
        <select className={selectClassName} defaultValue={filters.state ?? ""} name="state">
          <option value="">All</option>
          {states.map((state) => (
            <option key={state.name} value={state.name}>
              {state.name}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-medium text-zinc-500">
        Assignee
        <select
          className={selectClassName}
          defaultValue={filters.assignee === null ? unassignedValue : filters.assignee ?? ""}
          name="assignee"
        >
          <option value="">All</option>
          <option value={unassignedValue}>Unassigned</option>
          {data.actors.map((actor) => (
            <option key={actor.id} value={actor.handle}>
              {actor.handle}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-medium text-zinc-500">
        Project
        <select
          className={selectClassName}
          defaultValue={filters.project === null ? noProjectValue : filters.project ?? ""}
          name="project"
        >
          <option value="">All</option>
          <option value={noProjectValue}>No project</option>
          {data.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-medium text-zinc-500">
        Label
        <select className={selectClassName} defaultValue={filters.label ?? ""} name="label">
          <option value="">All</option>
          {data.labels.map((label) => (
            <option key={label.id} value={label.name}>
              {label.name}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-medium text-zinc-500">
        Priority
        <select
          className={selectClassName}
          defaultValue={filters.priority === undefined ? "" : String(filters.priority)}
          name="priority"
        >
          <option value="">All</option>
          {priorityOptions.map((priority) => (
            <option key={priority} value={priority}>
              P{priority}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-medium text-zinc-500">
        Cycle
        <select
          className={selectClassName}
          defaultValue={filters.cycle === undefined ? "" : String(filters.cycle)}
          name="cycle"
        >
          <option value="">All</option>
          {cycles.map((cycle) => (
            <option key={cycle.id} value={cycle.number}>
              #{cycle.number}
              {cycle.name ? ` ${cycle.name}` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="flex h-full items-end gap-2 pb-1 text-sm font-medium text-zinc-300">
        <input
          className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
          defaultChecked={filters.includeArchived === true}
          name="includeArchived"
          type="checkbox"
          value="true"
        />
        Include archived
      </label>

      <div className="flex items-end gap-2">
        <button
          className="h-8 rounded bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white"
          type="submit"
        >
          Apply
        </button>
        <Link
          className="flex h-8 items-center rounded border border-zinc-700 px-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
          href="/"
        >
          Clear
        </Link>
      </div>
    </form>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-20 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="text-base font-semibold text-zinc-100">{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function StateCell({ color, name }: { color?: string; name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-zinc-300">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? "#71717A" }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

function SetupNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "The tracker database is not ready.";

  return (
    <section className="rounded-md border border-amber-700/60 bg-amber-950/30 p-4">
      <h1 className="text-lg font-semibold text-amber-100">Tracker database is not initialized</h1>
      <p className="mt-2 text-sm text-amber-200">{message}</p>
      <p className="mt-3 text-sm text-amber-300">Run `tracker init`, then refresh this page.</p>
    </section>
  );
}

function issueListFiltersFromSearchParams(params: SearchParams): IssueListPageFilters {
  const priority = priorityFromParam(firstParam(params, "priority"));

  return omitUndefined({
    state: firstParam(params, "state"),
    assignee: nullableParam(firstParam(params, "assignee"), unassignedValue),
    project: nullableParam(firstParam(params, "project"), noProjectValue),
    label: firstParam(params, "label"),
    cycle: firstParam(params, "cycle"),
    priority,
    includeArchived: booleanParam(firstParam(params, "includeArchived"))
  }) as IssueListPageFilters;
}

function firstParam(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const firstValue = Array.isArray(value) ? value[0] : value;
  const trimmed = firstValue?.trim();

  return trimmed ? trimmed : undefined;
}

function nullableParam(value: string | undefined, nullValue: string): string | null | undefined {
  if (value === undefined) return undefined;
  return value === nullValue ? null : value;
}

function priorityFromParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const priority = Number.parseInt(value, 10);
  return priorityOptions.includes(priority) ? priority : undefined;
}

function booleanParam(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return ["1", "true", "on", "yes"].includes(value.toLowerCase()) ? true : undefined;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Partial<T>;
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const item of items) {
    const key = keyFor(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  return unique;
}
