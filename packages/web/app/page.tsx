import { IssueListClient } from "../src/components/issue-list-client";
import {
  getIssueListPageData,
  isTrackerSetupRequiredError,
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

export default async function IssueListPage({ searchParams }: IssueListPageProps = {}) {
  const filters = issueListFiltersFromSearchParams(searchParams ? await searchParams : {});

  try {
    const data = await getIssueListPageData(filters);

    return <IssueListClient data={data} filters={filters} />;
  } catch (error) {
    if (isTrackerSetupRequiredError(error)) {
      return <SetupNotice error={error} />;
    }

    throw error;
  }
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
    q: firstParam(params, "q"),
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
