import { getBoardPageData, isTrackerSetupRequiredError } from "../../src/data/queries";
import { moveBoardIssueAction } from "../../src/data/actions";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  try {
    const data = await getBoardPageData();
    const stateById = new Map(data.states.map((state) => [state.id, state]));
    const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));

    return (
      <div className="space-y-5">
        <section className="border-b border-zinc-800 pb-4">
          <h1 className="text-xl font-semibold text-zinc-50">Board</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {data.issues.length} open issue{data.issues.length === 1 ? "" : "s"} in workflow order.
          </p>
        </section>

        <section className="grid gap-3 overflow-x-auto pb-2 md:grid-flow-col md:auto-cols-[18rem]">
          {data.states.map((state) => {
            const issues = data.issues.filter((issue) => issue.stateId === state.id);

            return (
              <section
                aria-labelledby={`state-${state.id}`}
                className="min-h-80 rounded-md border border-zinc-800 bg-zinc-950"
                key={state.id}
              >
                <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: state.color }}
                    />
                    <h2
                      className="truncate text-sm font-semibold text-zinc-100"
                      id={`state-${state.id}`}
                    >
                      {state.name}
                    </h2>
                  </div>
                  <span className="rounded bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400">
                    {issues.length}
                  </span>
                </header>
                <div className="space-y-2 p-2">
                  {issues.map((issue) => {
                    const assignee = issue.assigneeId
                      ? actorById.get(issue.assigneeId)?.handle ?? "Unknown"
                      : "Unassigned";
                    const issueStates = data.states.filter(
                      (candidate) => candidate.teamId === issue.teamId
                    );

                    return (
                      <article
                        aria-label={`${issue.identifier} ${issue.title}`}
                        className="rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm"
                        key={issue.id}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-mono text-xs text-zinc-500">
                            {issue.identifier}
                          </span>
                          <span className="text-xs text-zinc-500">P{issue.priority}</span>
                        </div>
                        <h3 className="mt-2 line-clamp-2 font-medium text-zinc-100">
                          {issue.title}
                        </h3>
                        <p className="mt-2 truncate text-xs text-zinc-400">{assignee}</p>
                        <form action={moveBoardIssueAction} className="mt-3 flex gap-2">
                          <input name="identifier" type="hidden" value={issue.identifier} />
                          <label className="sr-only" htmlFor={`move-${issue.id}`}>
                            Move {issue.identifier} to state
                          </label>
                          <select
                            className="h-8 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-zinc-500"
                            defaultValue=""
                            id={`move-${issue.id}`}
                            name="state"
                            required
                          >
                            <option disabled value="">
                              Move to...
                            </option>
                            {issueStates
                              .filter((candidate) => candidate.id !== issue.stateId)
                              .map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.name}
                                </option>
                              ))}
                          </select>
                          <button
                            className="h-8 rounded bg-zinc-100 px-2 text-xs font-medium text-zinc-950 hover:bg-white"
                            type="submit"
                          >
                            Move
                          </button>
                        </form>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {data.issues.some((issue) => !stateById.has(issue.stateId)) ? (
            <div className="min-h-80 rounded-md border border-zinc-800 bg-zinc-950">
              <header className="border-b border-zinc-800 px-3 py-2">
                <h2 className="text-sm font-semibold text-zinc-100">Unknown state</h2>
              </header>
            </div>
          ) : null}
        </section>
      </div>
    );
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
