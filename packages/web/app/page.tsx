import { getIssueListPageData } from "../src/data/queries";

export const dynamic = "force-dynamic";

export default async function IssueListPage() {
  try {
    const data = await getIssueListPageData();

    return (
      <div className="space-y-5">
        <section className="flex flex-col gap-3 border-b border-zinc-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-50">Issues</h1>
            <p className="mt-1 text-sm text-zinc-400">
              {data.issues.length} open issue{data.issues.length === 1 ? "" : "s"} across{" "}
              {data.teams.length} team{data.teams.length === 1 ? "" : "s"}.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <Metric label="Projects" value={data.projects.length} />
            <Metric label="Labels" value={data.labels.length} />
            <Metric label="Teams" value={data.teams.length} />
          </div>
        </section>

        <section className="overflow-hidden rounded-md border border-zinc-800">
          <div className="grid grid-cols-[8rem_minmax(16rem,1fr)_7rem_8rem] border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium uppercase text-zinc-500">
            <span>Key</span>
            <span>Title</span>
            <span>Priority</span>
            <span>Updated</span>
          </div>
          <div className="divide-y divide-zinc-900">
            {data.issues.length > 0 ? (
              data.issues.map((issue) => (
                <article
                  className="grid grid-cols-[8rem_minmax(16rem,1fr)_7rem_8rem] items-center bg-zinc-950 px-3 py-2 text-sm hover:bg-zinc-900"
                  key={issue.id}
                >
                  <span className="font-mono text-xs text-zinc-400">{issue.identifier}</span>
                  <div className="min-w-0">
                    <h2 className="truncate font-medium text-zinc-100">{issue.title}</h2>
                    {issue.description ? (
                      <p className="mt-0.5 truncate text-xs text-zinc-500">{issue.description}</p>
                    ) : null}
                  </div>
                  <span className="text-zinc-400">P{issue.priority}</span>
                  <time className="text-xs text-zinc-500" dateTime={issue.updatedAt}>
                    {issue.updatedAt.slice(0, 10)}
                  </time>
                </article>
              ))
            ) : (
              <p className="bg-zinc-950 px-3 py-6 text-sm text-zinc-500">
                No issues yet. Create one with the CLI or MCP server.
              </p>
            )}
          </div>
        </section>
      </div>
    );
  } catch (error) {
    return <SetupNotice error={error} />;
  }
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-20 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="text-base font-semibold text-zinc-100">{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
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
