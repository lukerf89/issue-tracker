import { asc, eq } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { savedViews, type SavedView } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { whoami } from "./config.js";
import { uuid } from "../ids.js";
import { listIssueFiltersSchema } from "../schemas/issue.js";
import { listIssues, listIssuesPage, type IssuePage, type IssuePageOptions, type IssueWithDetails, type ListIssueFilters } from "./issue.js";

export interface CreateSavedViewInput {
  name: string;
  filters: ListIssueFilters;
  description?: string | null;
}

export interface DeleteSavedViewInput {
  idOrName: string;
}

export interface ResolveSavedViewInput {
  name: string;
}

export interface ListIssuesWithViewInput {
  view?: string;
  filters?: ListIssueFilters;
}

export type SavedViewWithFilters = Omit<SavedView, "filters"> & {
  filters: ListIssueFilters;
};

export function createSavedView(
  context: ServiceContext,
  input: CreateSavedViewInput
): SavedViewWithFilters {
  if (input.name.startsWith("builtin:")) throw new AppError(AppErrorCode.VALIDATION_FAILED, "The builtin: prefix is reserved.");
  const validatedFilters = listIssueFiltersSchema.strict().parse(input.filters);
  return inTransaction(context, (txContext) => {
    const existing = findSavedViewByName(txContext, input.name);

    if (existing) {
      throw new AppError(
        AppErrorCode.SAVED_VIEW_NAME_TAKEN,
        `Saved view ${input.name} already exists.`,
        { name: input.name }
      );
    }

    const now = txContext.clock.now().toISOString();
    const row = {
      id: uuid(),
      name: input.name,
      filters: validatedFilters,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now
    };

    txContext.db.insert(savedViews).values(row).run();
    return getSavedViewById(txContext, row.id);
  });
}

export function listSavedViews(context: ServiceContext): SavedViewWithFilters[] {
  return context.db.query.savedViews.findMany({
    orderBy: [asc(savedViews.name), asc(savedViews.id)]
  }).sync().map(savedViewWithParsedFilters);
}

export function deleteSavedView(
  context: ServiceContext,
  idOrName: string
): SavedViewWithFilters {
  return inTransaction(context, (txContext) => {
    const view = getSavedViewByIdOrName(txContext, idOrName);

    txContext.db.delete(savedViews).where(eq(savedViews.id, view.id)).run();
    return view;
  });
}

export function resolveSavedView(
  context: ServiceContext,
  name: string
): ListIssueFilters {
  const builtin = builtinIssueViews.find(view => view.name === name);
  if (builtin) {
    if (name === "builtin:my-open") {
      const actor = context.actor ?? whoami(context);
      if (actor.type !== "human") throw new AppError(AppErrorCode.VALIDATION_FAILED, "My open issues requires a current human actor.");
      return { ...builtin.filters, assignee: actor.id };
    }
    return listIssueFiltersSchema.parse(builtin.filters);
  }
  return getSavedViewByName(context, name).filters;
}

export function resolveIssueListFilters(
  context: ServiceContext,
  input: ListIssuesWithViewInput = {}
): ListIssueFilters {
  const baseFilters = input.view ? resolveSavedView(context, input.view) : {};
  return mergeIssueListFilters(baseFilters, input.filters ?? {});
}

export function listIssuesWithView(
  context: ServiceContext,
  input: ListIssuesWithViewInput = {}
): IssueWithDetails[] {
  return listIssues(context, resolveIssueListFilters(context, input));
}

export interface ListIssuesPageWithViewInput extends IssuePageOptions {
  view?: string;
  filters?: ListIssueFilters;
}

export function listIssuesPageWithView(
  context: ServiceContext,
  input: ListIssuesPageWithViewInput = {}
): IssuePage {
  const filters = resolveIssueListFilters(context, {
    view: input.view,
    filters: input.filters
  });
  return listIssuesPage(context, filters, { cursor: input.cursor, fields: input.fields });
}

function getSavedViewById(context: ServiceContext, id: string): SavedViewWithFilters {
  const view = context.db.query.savedViews.findFirst({
    where: eq(savedViews.id, id)
  }).sync();

  return view ? savedViewWithParsedFilters(view) : notFound(id);
}

function getSavedViewByName(context: ServiceContext, name: string): SavedViewWithFilters {
  const view = findSavedViewByName(context, name);

  return view ? savedViewWithParsedFilters(view) : notFound(name);
}

function getSavedViewByIdOrName(
  context: ServiceContext,
  idOrName: string
): SavedViewWithFilters {
  const view =
    context.db.query.savedViews.findFirst({
      where: eq(savedViews.id, idOrName)
    }).sync() ?? findSavedViewByName(context, idOrName);

  return view ? savedViewWithParsedFilters(view) : notFound(idOrName);
}

function findSavedViewByName(
  context: ServiceContext,
  name: string
): SavedView | undefined {
  return context.db.query.savedViews.findFirst({
    where: eq(savedViews.name, name)
  }).sync();
}

function savedViewWithParsedFilters(view: SavedView): SavedViewWithFilters {
  return {
    ...view,
    filters: parseStoredFilters(view.filters)
  };
}

function parseStoredFilters(filters: unknown): ListIssueFilters {
  const parsed = typeof filters === "string" ? JSON.parse(filters) as unknown : filters;
  return listIssueFiltersSchema.strict().parse(parsed);
}

function mergeIssueListFilters(
  viewFilters: ListIssueFilters,
  adHocFilters: ListIssueFilters
): ListIssueFilters {
  const merged: Record<string, unknown> = { ...viewFilters };

  for (const [key, value] of Object.entries(adHocFilters)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return listIssueFiltersSchema.parse(merged);
}

function notFound(idOrName: string): never {
  throw new AppError(
    AppErrorCode.SAVED_VIEW_NOT_FOUND,
    `Saved view ${idOrName} was not found.`,
    { savedView: idOrName }
  );
}


/** Open includes backlog, unstarted, started, and blocked; excludes completed/canceled. */
const openStateTypes: NonNullable<ListIssueFilters["stateTypes"]> = ["backlog", "unstarted", "started", "blocked"];
export const builtinIssueViews: ReadonlyArray<{ name: string; title: string; description: string; filters: ListIssueFilters }> = [
  { name: "builtin:my-open", title: "My open issues", description: "Current human; backlog, unstarted, started, blocked; non-archived; all teams", filters: { stateTypes: openStateTypes } },
  { name: "builtin:unassigned", title: "Unassigned", description: "Unassigned; all workflow states; non-archived; all teams", filters: { assignee: null } },
  { name: "builtin:all-open", title: "All open", description: "All assignees; backlog, unstarted, started, blocked; non-archived; all teams", filters: { stateTypes: openStateTypes } },
  { name: "builtin:recent", title: "Recently updated", description: "All non-archived issues; newest update first; all teams; no time cutoff", filters: { sort: "updatedAt" } }
];
