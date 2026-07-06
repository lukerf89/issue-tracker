"use client";

import Link from "next/link";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { createIssueFormAction } from "../data/actions";
import type { IssueListPageData, IssueListPageFilters } from "../data/queries";
import {
  issueListShortcutForEvent,
  nextSelectionIndex,
  type IssueListShortcutAction
} from "./issue-list-shortcuts";

interface IssueListClientProps {
  data: IssueListPageData;
  filters: IssueListPageFilters;
}

const unassignedValue = "__unassigned";
const noProjectValue = "__no_project";
const priorityOptions = [0, 1, 2, 3, 4];

const inputClassName =
  "mt-1 h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const selectClassName =
  "mt-1 h-8 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const textareaClassName =
  "mt-1 min-h-28 w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm leading-6 text-zinc-100 outline-none focus:border-zinc-500";

export function IssueListClient({ data, filters }: IssueListClientProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingGo, setPendingGo] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const stateById = useMemo(() => new Map(data.states.map((state) => [state.id, state])), [
    data.states
  ]);
  const actorById = useMemo(() => new Map(data.actors.map((actor) => [actor.id, actor])), [
    data.actors
  ]);

  useEffect(() => {
    if (selectedIndex !== null && selectedIndex >= data.issues.length) {
      setSelectedIndex(data.issues.length > 0 ? data.issues.length - 1 : null);
    }
  }, [data.issues.length, selectedIndex]);

  useEffect(() => {
    if (createOpen) {
      titleInputRef.current?.focus();
    }
  }, [createOpen]);

  useEffect(() => {
    if (selectedIndex !== null) {
      rowRefs.current[selectedIndex]?.focus({ preventScroll: true });
    }
  }, [selectedIndex]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const result = issueListShortcutForEvent(event, {
        createOpen,
        hasSelection: selectedIndex !== null,
        pendingGo
      });

      setPendingGo(result.pendingGo);

      if (result.action === "none") {
        return;
      }

      event.preventDefault();
      handleShortcutAction(result.action);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createOpen, data.issues, pendingGo, selectedIndex]);

  function handleShortcutAction(action: IssueListShortcutAction): void {
    switch (action) {
      case "openCreate":
        setCreateError(null);
        setCreateOpen(true);
        break;
      case "selectNext":
        setSelectedIndex((current) => nextSelectionIndex(current, "next", data.issues.length));
        break;
      case "selectPrevious":
        setSelectedIndex((current) =>
          nextSelectionIndex(current, "previous", data.issues.length)
        );
        break;
      case "openSelected": {
        const selectedIssue = selectedIndex === null ? null : data.issues[selectedIndex];
        if (selectedIssue) {
          navigateTo(`/issues/${selectedIssue.identifier}`);
        }
        break;
      }
      case "focusSearch":
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        break;
      case "goBoard":
        navigateTo("/board");
        break;
      case "goList":
        navigateTo("/");
        break;
      case "closeCreate":
        setCreateOpen(false);
        setCreateError(null);
        break;
      case "clearSelection":
        setSelectedIndex(null);
        break;
      case "none":
        break;
    }
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatePending(true);
    setCreateError(null);

    try {
      const issue = await createIssueFormAction(new FormData(event.currentTarget));
      navigateTo(`/issues/${issue.identifier}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Issue creation failed.");
      setCreatePending(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="flex flex-col gap-3 border-b border-zinc-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-50">Issues</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Showing {data.issues.length} issue{data.issues.length === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid grid-cols-3 gap-2 text-sm">
            <Metric label="Projects" value={data.projects.length} />
            <Metric label="Labels" value={data.labels.length} />
            <Metric label="Teams" value={data.teams.length} />
          </div>
          <button
            className="h-9 rounded bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
            type="button"
          >
            New issue
          </button>
        </div>
      </section>

      <FilterBar data={data} filters={filters} searchInputRef={searchInputRef} />

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
                data.issues.map((issue, index) => {
                  const state = stateById.get(issue.stateId);
                  const assignee = issue.assigneeId
                    ? actorById.get(issue.assigneeId)?.handle ?? "Unknown"
                    : "Unassigned";
                  const selected = selectedIndex === index;

                  return (
                    <Link
                      aria-label={`${issue.identifier} ${issue.title}`}
                      className={issueRowClassName(selected)}
                      href={`/issues/${issue.identifier}`}
                      key={issue.id}
                      onFocus={() => setSelectedIndex(index)}
                      ref={(node) => {
                        rowRefs.current[index] = node;
                      }}
                    >
                      <span className="font-mono text-xs text-zinc-400">{issue.identifier}</span>
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

      {createOpen ? (
        <CreateIssueDialog
          data={data}
          error={createError}
          onClose={() => {
            setCreateOpen(false);
            setCreateError(null);
          }}
          onSubmit={handleCreateSubmit}
          pending={createPending}
          titleInputRef={titleInputRef}
        />
      ) : null}
    </div>
  );
}

function FilterBar({
  data,
  filters,
  searchInputRef
}: {
  data: IssueListPageData;
  filters: IssueListPageFilters;
  searchInputRef: RefObject<HTMLInputElement | null>;
}) {
  const states = uniqueBy(data.states, (state) => state.name);
  const cycles = uniqueBy(data.cycles, (cycle) => String(cycle.number));

  return (
    <form
      action="/"
      className="grid gap-3 rounded-md border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-[minmax(14rem,2fr)_repeat(6,minmax(0,1fr))_auto_auto]"
      method="get"
    >
      <label className="text-xs font-medium text-zinc-500">
        Search
        <input
          className={inputClassName}
          defaultValue={filters.q ?? ""}
          name="q"
          ref={searchInputRef}
          type="search"
        />
      </label>

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

function CreateIssueDialog({
  data,
  error,
  onClose,
  onSubmit,
  pending,
  titleInputRef
}: {
  data: IssueListPageData;
  error: string | null;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  titleInputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 py-12">
      <section
        aria-labelledby="create-issue-heading"
        aria-modal="true"
        className="w-full max-w-2xl rounded-md border border-zinc-800 bg-zinc-950 shadow-2xl"
        role="dialog"
      >
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 className="text-base font-semibold text-zinc-50" id="create-issue-heading">
            Create issue
          </h2>
          <button
            className="rounded border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </header>
        <form className="grid gap-4 p-4" onSubmit={onSubmit}>
          <label className="text-xs font-medium text-zinc-500">
            Title
            <input
              className={inputClassName}
              name="title"
              ref={titleInputRef}
              required
              type="text"
            />
          </label>

          <label className="text-xs font-medium text-zinc-500">
            Description
            <textarea className={textareaClassName} name="description" />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-zinc-500">
              Team
              <select
                className={selectClassName}
                defaultValue={data.teams[0]?.id ?? ""}
                name="team"
                required
              >
                {data.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.key} · {team.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-zinc-500">
              Priority
              <select className={selectClassName} defaultValue="0" name="priority">
                {priorityOptions.map((priority) => (
                  <option key={priority} value={priority}>
                    P{priority}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-zinc-500">
              Project
              <select className={selectClassName} defaultValue="" name="project">
                <option value="">No project</option>
                {data.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-zinc-500">
              Assignee
              <select className={selectClassName} defaultValue="" name="assignee">
                <option value="">Unassigned</option>
                {data.actors.map((actor) => (
                  <option key={actor.id} value={actor.handle}>
                    {actor.handle}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="rounded-md border border-zinc-800 p-3">
            <legend className="px-1 text-xs font-medium text-zinc-500">Labels</legend>
            {data.labels.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {data.labels.map((label) => (
                  <label
                    className="flex min-w-0 items-center gap-2 rounded border border-zinc-900 bg-zinc-950 px-2 py-2 text-sm text-zinc-300"
                    key={label.id}
                  >
                    <input
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
                      name="labels"
                      type="checkbox"
                      value={label.id}
                    />
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="truncate">{label.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">No labels.</p>
            )}
          </fieldset>

          {error ? (
            <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              className="h-9 rounded border border-zinc-700 px-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="h-9 rounded bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
              disabled={pending}
              type="submit"
            >
              {pending ? "Creating..." : "Create issue"}
            </button>
          </div>
        </form>
      </section>
    </div>
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

function issueRowClassName(selected: boolean): string {
  const base =
    "grid grid-cols-[7rem_4rem_9rem_minmax(18rem,1fr)_10rem] items-center gap-3 px-3 py-2 text-sm focus:outline-none";
  const state = selected
    ? "bg-zinc-800 ring-1 ring-inset ring-zinc-600"
    : "bg-zinc-950 hover:bg-zinc-900 focus:bg-zinc-900";

  return `${base} ${state}`;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const item of items) {
    const value = key(item);
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(item);
    }
  }

  return unique;
}

function navigateTo(path: string): void {
  window.location.assign(path);
}
