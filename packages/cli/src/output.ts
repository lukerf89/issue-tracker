import {
  AppErrorCode,
  errorEnvelope,
  getActor,
  getState,
  serializeActor,
  serializeComment,
  serializeCycle,
  serializeIssue,
  serializeLabel,
  serializeProject,
  serializeTeam,
  type Actor,
  type CommentWithAuthor,
  type Cycle,
  type Issue,
  type IssueReference,
  type Label,
  type Project,
  type ServiceContext,
  type Team
} from "@issue-tracker/core";
import pc from "picocolors";

export interface OutputOptions {
  json?: boolean;
}

export interface IssueListRow {
  issue: Issue;
  state: string;
  assignee: string | null;
  labels: string;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printValue(value: string | null): void {
  process.stdout.write(`${value ?? ""}\n`);
}

export function printActor(actor: Actor, options: OutputOptions): void {
  if (options.json) {
    printJson(serializeActor(actor));
    return;
  }

  process.stdout.write(`${actor.handle} (${actor.name})\n`);
}

export function printActors(actors: Actor[], options: OutputOptions): void {
  if (options.json) {
    printJson(actors.map(serializeActor));
    return;
  }

  for (const actor of actors) {
    process.stdout.write(`${pc.bold(actor.handle)}  ${actor.type}  ${actor.name}\n`);
  }
}

export function printTeams(teams: Team[], options: OutputOptions): void {
  if (options.json) {
    printJson(teams.map(serializeTeam));
    return;
  }

  for (const team of teams) {
    process.stdout.write(`${pc.bold(team.key)}  ${team.name}\n`);
  }
}

export function printTeam(team: Team, options: OutputOptions): void {
  if (options.json) {
    printJson(serializeTeam(team));
    return;
  }

  process.stdout.write(`${pc.bold(team.key)}  ${team.name}\n`);
}

export function printProjects(projects: Project[], options: OutputOptions): void {
  if (options.json) {
    printJson(projects.map(serializeProject));
    return;
  }

  for (const project of projects) {
    process.stdout.write(`${pc.bold(project.name)}  ${project.status}\n`);
  }
}

export function printCycles(cycles: Cycle[], options: OutputOptions): void {
  if (options.json) {
    printJson(cycles.map(serializeCycle));
    return;
  }

  for (const cycle of cycles) {
    process.stdout.write(`${pc.bold(`#${cycle.number}`)}  ${cycle.name ?? ""}\n`);
  }
}

export function printCycle(cycle: Cycle, options: OutputOptions): void {
  if (options.json) {
    printJson(serializeCycle(cycle));
    return;
  }

  process.stdout.write(`${pc.bold(`#${cycle.number}`)}  ${cycle.name ?? ""}\n`);
}

export function printLabels(labels: Label[], options: OutputOptions): void {
  if (options.json) {
    printJson(labels.map(serializeLabel));
    return;
  }

  for (const label of labels) {
    process.stdout.write(`${pc.bold(label.name)}  ${label.color}  ${label.group ?? ""}\n`);
  }
}

export function printLabel(label: Label, options: OutputOptions): void {
  if (options.json) {
    printJson(serializeLabel(label));
    return;
  }

  process.stdout.write(`${pc.bold(label.name)}  ${label.color}  ${label.group ?? ""}\n`);
}

export function printComment(comment: CommentWithAuthor, options: OutputOptions): void {
  if (options.json) {
    printJson(serializeComment(comment));
    return;
  }

  process.stdout.write(`${formatCommentLines(comment, 0).join("\n")}\n`);
}

export function printProject(project: Project, options: OutputOptions): void {
  if (options.json) {
    printJson(serializeProject(project));
    return;
  }

  process.stdout.write(`${pc.bold(project.name)}  ${project.status}\n`);
}

export function printIssue(context: ServiceContext, issue: Issue, options: OutputOptions): void {
  if (options.json) {
    printJson(serializeIssue(issue));
    return;
  }

  const row = issueRow(context, issue);
  printIssueTable([row]);
  printIssueRelations(issue);
}

export function printIssues(
  context: ServiceContext,
  issues: Issue[],
  options: OutputOptions
): void {
  if (options.json) {
    printJson(issues.map(serializeIssue));
    return;
  }

  printIssueTable(issues.map((issue) => issueRow(context, issue)));
}

export function handleCliError(error: unknown): number {
  if (isCommanderHelp(error)) {
    return 0;
  }

  const envelope = isCommanderError(error)
    ? {
        error: {
          code: AppErrorCode.VALIDATION_FAILED,
          message: error.message
        }
      }
    : errorEnvelope(error);
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
  return 1;
}

function printIssueTable(rows: IssueListRow[]): void {
  if (rows.length === 0) return;

  const widths = {
    identifier: Math.max("ID".length, ...rows.map((row) => row.issue.identifier.length)),
    priority: Math.max("P".length, ...rows.map((row) => String(row.issue.priority).length)),
    state: Math.max("State".length, ...rows.map((row) => row.state.length)),
    title: Math.max("Title".length, ...rows.map((row) => row.issue.title.length)),
    assignee: Math.max(
      "Assignee".length,
      ...rows.map((row) => (row.assignee ?? "Unassigned").length)
    ),
    labels: Math.max("Labels".length, ...rows.map((row) => row.labels.length))
  };

  process.stdout.write(
    pc.dim(
      [
        pad("ID", widths.identifier),
        pad("P", widths.priority),
        pad("State", widths.state),
        pad("Title", widths.title),
        pad("Assignee", widths.assignee),
        pad("Labels", widths.labels)
      ].join("  ")
    ) + "\n"
  );

  for (const row of rows) {
    process.stdout.write(
      [
        pc.bold(pad(row.issue.identifier, widths.identifier)),
        pad(String(row.issue.priority), widths.priority),
        pad(row.state, widths.state),
        pad(row.issue.title, widths.title),
        pad(row.assignee ?? "Unassigned", widths.assignee),
        pad(row.labels, widths.labels)
      ].join("  ") + "\n"
    );
  }
}

function issueRow(context: ServiceContext, issue: Issue): IssueListRow {
  const state = getState(context, issue.stateId, issue.teamId).name;
  const assignee = issue.assigneeId ? getActor(context, issue.assigneeId).handle : null;
  const labels = issueLabels(issue).join(", ");
  return { issue, state, assignee, labels };
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function issueLabels(issue: Issue): string[] {
  const maybeLabeled = issue as Issue & { labels?: Label[] };
  return (maybeLabeled.labels ?? []).map((label) => label.name);
}

function printIssueRelations(issue: Issue): void {
  const detail = issue as Issue & {
    parent?: IssueReference | null;
    children?: IssueReference[];
    comments?: CommentWithAuthor[];
  };
  const lines: string[] = [];

  if (hasOwn(detail, "parent") && detail.parent) {
    lines.push(`Parent    ${pc.bold(detail.parent.identifier)}  ${detail.parent.title}`);
  }

  if (hasOwn(detail, "children") && detail.children && detail.children.length > 0) {
    lines.push("Children");

    for (const child of detail.children) {
      lines.push(`  ${pc.bold(child.identifier)}  ${child.title}`);
    }
  }

  if (hasOwn(detail, "comments") && detail.comments && detail.comments.length > 0) {
    lines.push("Comments");
    lines.push(...commentThreadLines(detail.comments));
  }

  if (lines.length > 0) {
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}

function commentThreadLines(comments: CommentWithAuthor[]): string[] {
  const knownIds = new Set(comments.map((comment) => comment.id));
  const childrenByParent = new Map<string | null, CommentWithAuthor[]>();

  for (const comment of comments) {
    const parentKey = comment.parentId && knownIds.has(comment.parentId)
      ? comment.parentId
      : null;
    childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) ?? []), comment]);
  }

  const lines: string[] = [];
  const visited = new Set<string>();
  const appendComment = (comment: CommentWithAuthor, depth: number): void => {
    if (visited.has(comment.id)) return;
    visited.add(comment.id);
    lines.push(...formatCommentLines(comment, depth));

    for (const child of childrenByParent.get(comment.id) ?? []) {
      appendComment(child, depth + 1);
    }
  };

  for (const comment of childrenByParent.get(null) ?? []) {
    appendComment(comment, 0);
  }

  for (const comment of comments) {
    appendComment(comment, 0);
  }

  return lines;
}

function formatCommentLines(comment: CommentWithAuthor, depth: number): string[] {
  const indent = "  ".repeat(depth + 1);
  const [firstLine = "", ...rest] = comment.body.split(/\r?\n/);

  return [
    `${indent}${pc.bold(`@${comment.author.handle}`)}  ${firstLine}`,
    ...rest.map((line) => `${indent}  ${line}`)
  ];
}

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isCommanderError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("commander.")
  );
}

function isCommanderHelp(error: unknown): boolean {
  return isCommanderError(error) && error.code === "commander.helpDisplayed";
}
