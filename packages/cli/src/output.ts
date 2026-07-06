import { inspect } from "node:util";

import {
  AppError,
  AppErrorCode,
  getActor,
  getState,
  serializeActor,
  serializeIssue,
  serializeProject,
  serializeTeam,
  type Actor,
  type Issue,
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

  const envelope = errorEnvelope(error);
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
    )
  };

  process.stdout.write(
    pc.dim(
      [
        pad("ID", widths.identifier),
        pad("P", widths.priority),
        pad("State", widths.state),
        pad("Title", widths.title),
        pad("Assignee", widths.assignee)
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
        pad(row.assignee ?? "Unassigned", widths.assignee)
      ].join("  ") + "\n"
    );
  }
}

function issueRow(context: ServiceContext, issue: Issue): IssueListRow {
  const state = getState(context, issue.stateId, issue.teamId).name;
  const assignee = issue.assigneeId ? getActor(context, issue.assigneeId).handle : null;
  return { issue, state, assignee };
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function errorEnvelope(error: unknown) {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }

  if (isCommanderError(error)) {
    return {
      error: {
        code: AppErrorCode.VALIDATION_FAILED,
        message: error.message
      }
    };
  }

  if (isZodError(error)) {
    return {
      error: {
        code: AppErrorCode.VALIDATION_FAILED,
        message: "Input validation failed.",
        details: { issues: error.issues }
      }
    };
  }

  return {
    error: {
      code: AppErrorCode.DATABASE_ERROR,
      message: error instanceof Error ? error.message : inspect(error)
    }
  };
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

function isZodError(error: unknown): error is { issues: unknown[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ZodError" &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}
