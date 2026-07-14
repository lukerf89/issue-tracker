import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Markdown } from "../../../src/components/markdown";
import {
  addIssueCommentAction,
  assignIssueDetailAction,
  moveIssueDetailAction,
  updateIssueDetailFieldsAction,
  updateIssueLabelAction
} from "../../../src/data/actions";
import {
  getIssueDetailPageData,
  isIssueNotFoundError,
  type IssueDetailPageData
} from "../../../src/data/queries";

export const dynamic = "force-dynamic";

interface IssueDetailPageProps {
  params: Promise<{ identifier: string }>;
}

type IssueDetailIssue = IssueDetailPageData["issue"];
type IssueComment = NonNullable<IssueDetailIssue["comments"]>[number];
type ActivityEntry = IssueDetailPageData["activity"][number];

const inputClassName =
  "mt-1 h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const selectClassName =
  "mt-1 h-9 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const textareaClassName =
  "mt-1 min-h-32 w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm leading-6 text-zinc-100 outline-none focus:border-zinc-500";
const primaryButtonClassName =
  "h-9 rounded bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white";
const secondaryButtonClassName =
  "h-8 rounded border border-zinc-700 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50";

export default async function IssueDetailPage({ params }: IssueDetailPageProps) {
  const { identifier } = await params;
  let data: IssueDetailPageData;

  try {
    data = await getIssueDetailPageData(identifier);
  } catch (error) {
    if (isIssueNotFoundError(error)) {
      notFound();
    }

    return <SetupNotice error={error} />;
  }

  const { issue } = data;
  const stateById = new Map(data.states.map((state) => [state.id, state]));
  const actorById = new Map(data.actors.map((actor) => [actor.id, actor]));
  const projectById = new Map(data.projects.map((project) => [project.id, project]));
  const cycleById = new Map(data.cycles.map((cycle) => [cycle.id, cycle]));
  const teamById = new Map(data.teams.map((team) => [team.id, team]));
  const state = stateById.get(issue.stateId);
  const assignee = issue.assigneeId ? actorById.get(issue.assigneeId) : null;
  const creator = actorById.get(issue.creatorId);
  const project = issue.projectId ? projectById.get(issue.projectId) : null;
  const cycle = issue.cycleId ? cycleById.get(issue.cycleId) : null;
  const team = teamById.get(issue.teamId);
  const comments = issue.comments ?? [];
  const attachments = issue.attachments ?? [];
  const childIssues = issue.children ?? [];
  const blockedByIssues = issue.blockedBy ?? [];
  const blocksIssues = issue.blocks ?? [];
  const currentLabelIds = new Set(issue.labels.map((label) => label.id));
  const availableLabels = data.labels.filter((label) => !currentLabelIds.has(label.id));

  return (
    <div className="space-y-5">
      <header className="border-b border-zinc-800 pb-4">
        <Link className="text-sm text-zinc-400 hover:text-zinc-100" href="/">
          Back to issues
        </Link>
        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="font-mono text-sm text-zinc-500">{issue.identifier}</p>
            <h1 className="mt-1 text-2xl font-semibold text-zinc-50">{issue.title}</h1>
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm sm:min-w-80">
            <Metric label="State" value={state?.name ?? "Unknown"} />
            <Metric label="Priority" value={`P${issue.priority}`} />
            <Metric label="Assignee" value={assignee?.handle ?? "Unassigned"} />
          </div>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="space-y-5">
          <section aria-labelledby="description-heading" className="border-b border-zinc-800 pb-5">
            <h2 className="text-base font-semibold text-zinc-100" id="description-heading">
              Description
            </h2>
            <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950 p-4">
              <Markdown emptyLabel="No description." source={issue.description} />
            </div>
          </section>

          <section aria-labelledby="edit-heading" className="border-b border-zinc-800 pb-5">
            <h2 className="text-base font-semibold text-zinc-100" id="edit-heading">
              Edit issue
            </h2>
            <form action={updateIssueDetailFieldsAction} className="mt-3 grid gap-3">
              <input name="identifier" type="hidden" value={issue.identifier} />
              <label className="text-xs font-medium text-zinc-500">
                Title
                <input
                  className={inputClassName}
                  defaultValue={issue.title}
                  name="title"
                  required
                  type="text"
                />
              </label>
              <label className="text-xs font-medium text-zinc-500">
                Description
                <textarea
                  className={textareaClassName}
                  defaultValue={issue.description ?? ""}
                  name="description"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-[12rem_auto] sm:items-end">
                <label className="text-xs font-medium text-zinc-500">
                  Priority
                  <select className={selectClassName} defaultValue={issue.priority} name="priority">
                    {[0, 1, 2, 3, 4].map((priority) => (
                      <option key={priority} value={priority}>
                        P{priority}
                      </option>
                    ))}
                  </select>
                </label>
                <button className={primaryButtonClassName} type="submit">
                  Save
                </button>
              </div>
            </form>
          </section>

          <section aria-labelledby="relations-heading" className="border-b border-zinc-800 pb-5">
            <h2 className="text-base font-semibold text-zinc-100" id="relations-heading">
              Parent and sub-issues
            </h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <RelationPanel title="Parent issue">
                {issue.parent ? (
                  <IssueReferenceLink issue={issue.parent} />
                ) : (
                  <p className="text-sm text-zinc-500">No parent issue.</p>
                )}
              </RelationPanel>
              <RelationPanel title="Sub-issues">
                {childIssues.length > 0 ? (
                  <ul className="space-y-2">
                    {childIssues.map((child) => (
                      <li key={child.id}>
                        <IssueReferenceLink issue={child} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-zinc-500">No sub-issues.</p>
                )}
              </RelationPanel>
            </div>
          </section>

          <section aria-labelledby="dependencies-heading" className="border-b border-zinc-800 pb-5">
            <h2 className="text-base font-semibold text-zinc-100" id="dependencies-heading">
              Dependencies
            </h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <RelationPanel title="Blocked by">
                {blockedByIssues.length > 0 ? (
                  <ul className="space-y-2">
                    {blockedByIssues.map((blocker) => (
                      <li key={blocker.id}>
                        <IssueReferenceLink issue={blocker} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-zinc-500">Not blocked by any issues.</p>
                )}
              </RelationPanel>
              <RelationPanel title="Blocks">
                {blocksIssues.length > 0 ? (
                  <ul className="space-y-2">
                    {blocksIssues.map((blocked) => (
                      <li key={blocked.id}>
                        <IssueReferenceLink issue={blocked} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-zinc-500">Does not block any issues.</p>
                )}
              </RelationPanel>
            </div>
          </section>

          <section aria-labelledby="attachments-heading" className="border-b border-zinc-800 pb-5">
            <h2 className="text-base font-semibold text-zinc-100" id="attachments-heading">
              Attachments
            </h2>
            {attachments.length > 0 ? (
              <ul className="mt-3 divide-y divide-zinc-900 rounded-md border border-zinc-800">
                {attachments.map((attachment) => (
                  <li className="bg-zinc-950 px-3 py-3" key={attachment.id}>
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-100">{attachment.title}</p>
                        <p className="mt-1 font-mono text-xs text-zinc-500">
                          {attachment.kind}
                          {attachment.repoPath ? ` · ${attachment.repoPath}` : ""}
                          {attachment.branchName ? ` · ${attachment.branchName}` : ""}
                          {attachment.commitSha ? ` · ${attachment.commitSha}` : ""}
                        </p>
                      </div>
                      {attachment.url ? (
                        <a
                          className="text-sm text-sky-300 hover:text-sky-200"
                          href={attachment.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open
                        </a>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-zinc-500">No attachments.</p>
            )}
          </section>

          <section aria-labelledby="comments-heading" className="border-b border-zinc-800 pb-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-zinc-100" id="comments-heading">
                Comments
              </h2>
              <span className="rounded bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400">
                {comments.length}
              </span>
            </div>
            <CommentThread comments={comments} />
            <form action={addIssueCommentAction} className="mt-4 grid gap-3">
              <input name="identifier" type="hidden" value={issue.identifier} />
              <label className="text-xs font-medium text-zinc-500">
                Reply to
                <select className={selectClassName} defaultValue="" name="parent">
                  <option value="">New top-level comment</option>
                  {comments.map((comment) => (
                    <option key={comment.id} value={comment.id}>
                      {comment.author.handle}: {comment.body.slice(0, 64)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-zinc-500">
                Comment
                <textarea className={textareaClassName} name="body" required />
              </label>
              <div>
                <button className={primaryButtonClassName} type="submit">
                  Add comment
                </button>
              </div>
            </form>
          </section>

          <section aria-labelledby="activity-heading">
            <h2 className="text-base font-semibold text-zinc-100" id="activity-heading">
              Activity
            </h2>
            <ActivityTrail activity={data.activity} />
          </section>
        </main>

        <aside className="space-y-5">
          <section aria-labelledby="properties-heading" className="rounded-md border border-zinc-800">
            <h2
              className="border-b border-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-100"
              id="properties-heading"
            >
              Properties
            </h2>
            <dl className="divide-y divide-zinc-900 px-3">
              <Property label="Team" value={team ? `${team.key} · ${team.name}` : "Unknown"} />
              <Property label="State" value={state?.name ?? "Unknown"} />
              <Property label="Priority" value={`P${issue.priority}`} />
              <Property label="Assignee" value={assignee?.handle ?? "Unassigned"} />
              <Property label="Creator" value={creator?.handle ?? "Unknown"} />
              <Property label="Project" value={project?.name ?? "No project"} />
              <Property
                label="Cycle"
                value={cycle ? `#${cycle.number}${cycle.name ? ` ${cycle.name}` : ""}` : "No cycle"}
              />
              <Property label="Created" value={formatDateTime(issue.createdAt)} />
              <Property label="Updated" value={formatDateTime(issue.updatedAt)} />
            </dl>
          </section>

          <section aria-labelledby="workflow-heading" className="rounded-md border border-zinc-800 p-3">
            <h2 className="text-sm font-semibold text-zinc-100" id="workflow-heading">
              Workflow
            </h2>
            <form action={moveIssueDetailAction} className="mt-3 grid gap-2">
              <input name="identifier" type="hidden" value={issue.identifier} />
              <label className="text-xs font-medium text-zinc-500">
                Move state
                <select className={selectClassName} defaultValue={issue.stateId} name="state">
                  {data.states.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className={secondaryButtonClassName} type="submit">
                Move
              </button>
            </form>
            <form action={assignIssueDetailAction} className="mt-4 grid gap-2">
              <input name="identifier" type="hidden" value={issue.identifier} />
              <label className="text-xs font-medium text-zinc-500">
                Assign
                <select
                  className={selectClassName}
                  defaultValue={assignee?.handle ?? "--none"}
                  name="actor"
                >
                  {data.currentActor ? (
                    <option value="--me">Me (--me)</option>
                  ) : null}
                  <option value="--none">Unassigned</option>
                  {data.actors.map((actor) => (
                    <option key={actor.id} value={actor.handle}>
                      {actor.handle}
                    </option>
                  ))}
                </select>
              </label>
              <button className={secondaryButtonClassName} type="submit">
                Assign
              </button>
            </form>
          </section>

          <section aria-labelledby="labels-heading" className="rounded-md border border-zinc-800 p-3">
            <h2 className="text-sm font-semibold text-zinc-100" id="labels-heading">
              Labels
            </h2>
            <div aria-label="Current labels" className="mt-3 space-y-2">
              {issue.labels.length > 0 ? (
                issue.labels.map((label) => (
                  <form
                    action={updateIssueLabelAction}
                    className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950 px-2 py-2"
                    key={label.id}
                  >
                    <input name="identifier" type="hidden" value={issue.identifier} />
                    <input name="labelId" type="hidden" value={label.id} />
                    <input name="operation" type="hidden" value="remove" />
                    <span className="flex min-w-0 items-center gap-2 text-sm text-zinc-200">
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: label.color }}
                      />
                      <span className="truncate">{label.name}</span>
                    </span>
                    <button className={secondaryButtonClassName} type="submit">
                      Remove
                    </button>
                  </form>
                ))
              ) : (
                <p className="text-sm text-zinc-500">No labels.</p>
              )}
            </div>
            <div aria-label="Available labels" className="mt-3 space-y-2">
              {availableLabels.map((label) => (
                <form
                  action={updateIssueLabelAction}
                  className="flex items-center justify-between gap-2 rounded border border-zinc-900 px-2 py-2"
                  key={label.id}
                >
                  <input name="identifier" type="hidden" value={issue.identifier} />
                  <input name="labelId" type="hidden" value={label.id} />
                  <input name="operation" type="hidden" value="add" />
                  <span className="flex min-w-0 items-center gap-2 text-sm text-zinc-400">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="truncate">{label.name}</span>
                  </span>
                  <button className={secondaryButtonClassName} type="submit">
                    Add
                  </button>
                </form>
              ))}
              {availableLabels.length === 0 ? (
                <p className="text-sm text-zinc-500">No more labels.</p>
              ) : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="truncate text-sm font-semibold text-zinc-100">{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function Property({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 py-2 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 truncate text-zinc-200">{value}</dd>
    </div>
  );
}

function RelationPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
      <h3 className="text-sm font-medium text-zinc-300">{title}</h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function IssueReferenceLink({
  issue
}: {
  issue: { identifier: string; title: string };
}) {
  return (
    <Link
      aria-label={`${issue.identifier} ${issue.title}`}
      className="flex min-w-0 items-center gap-2 text-sm text-zinc-200 hover:text-zinc-50"
      href={`/issues/${issue.identifier}`}
    >
      <span className="shrink-0 font-mono text-xs text-zinc-500">{issue.identifier}</span>
      <span className="truncate">{issue.title}</span>
    </Link>
  );
}

function CommentThread({ comments }: { comments: IssueComment[] }) {
  if (comments.length === 0) {
    return <p className="mt-3 text-sm text-zinc-500">No comments.</p>;
  }

  const byParentId = new Map<string | null, IssueComment[]>();
  const commentIds = new Set(comments.map((comment) => comment.id));

  for (const comment of comments) {
    const parentId = comment.parentId && commentIds.has(comment.parentId) ? comment.parentId : null;
    byParentId.set(parentId, [...(byParentId.get(parentId) ?? []), comment]);
  }

  return (
    <div className="mt-3 space-y-3">
      {(byParentId.get(null) ?? []).map((comment) => renderComment(comment, byParentId, 0))}
    </div>
  );
}

function renderComment(
  comment: IssueComment,
  byParentId: Map<string | null, IssueComment[]>,
  depth: number
) {
  const replies = byParentId.get(comment.id) ?? [];

  return (
    <article
      className="rounded-md border border-zinc-800 bg-zinc-950 p-3"
      key={comment.id}
      style={{ marginLeft: depth === 0 ? undefined : `${Math.min(depth, 3) * 1.25}rem` }}
    >
      <header className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-300">{comment.author.handle}</span>
        <time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
        {comment.parentId ? <span>Reply</span> : null}
      </header>
      <div className="mt-2">
        <Markdown source={comment.body} />
      </div>
      {replies.length > 0 ? (
        <div className="mt-3 space-y-3">
          {replies.map((reply) => renderComment(reply, byParentId, depth + 1))}
        </div>
      ) : null}
    </article>
  );
}

function ActivityTrail({ activity }: { activity: ActivityEntry[] }) {
  if (activity.length === 0) {
    return <p className="mt-3 text-sm text-zinc-500">No activity.</p>;
  }

  return (
    <ol className="mt-3 space-y-2">
      {activity.map((entry) => (
        <li className="rounded-md border border-zinc-800 bg-zinc-950 p-3" key={entry.id}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-zinc-100">{humanizeAction(entry.action)}</span>
            <span className="text-zinc-500">by {entry.actor.handle}</span>
            <time className="text-zinc-500" dateTime={entry.createdAt}>
              {formatDateTime(entry.createdAt)}
            </time>
          </div>
          <p className="mt-1 text-sm text-zinc-400">{activitySummary(entry)}</p>
        </li>
      ))}
    </ol>
  );
}

function activitySummary(entry: ActivityEntry): string {
  switch (entry.action) {
    case "created":
      return `Created ${stringData(entry.data, "identifier") ?? "issue"}.`;
    case "updated":
      return `Updated ${Object.keys(recordData(entry.data, "changed")).join(", ") || "fields"}.`;
    case "state_changed":
      return `${stringData(entry.data, "fromName") ?? "Unknown"} to ${
        stringData(entry.data, "toName") ?? "Unknown"
      }.`;
    case "assigned":
      return `${stringData(entry.data, "fromHandle") ?? "Unassigned"} to ${
        stringData(entry.data, "toHandle") ?? "Unassigned"
      }.`;
    case "commented":
      return "Added a comment.";
    case "label_added":
      return `Added ${stringData(entry.data, "labelName") ?? "label"}.`;
    case "label_removed":
      return `Removed ${stringData(entry.data, "labelName") ?? "label"}.`;
    case "linked":
      return `Linked ${stringData(entry.data, "kind") ?? "attachment"} ${
        stringData(entry.data, "title") ?? ""
      }.`.trim();
    default:
      return JSON.stringify(entry.data);
  }
}

function humanizeAction(action: string): string {
  return action.replace(/_/g, " ");
}

function recordData(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = data[key];
  return isRecord(value) ? value : {};
}

function stringData(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value));
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
