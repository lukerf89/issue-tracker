import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addRepository, associateRepository, createIssue, createNodeRepositoryInspector, createProject, getRun, listRuns, previewRun, startRun, type ServiceContext
} from "@issue-tracker/core";
import { expect, it } from "vitest";

import { agentFixture } from "./agent-fixture.js";

type Fixture = Awaited<ReturnType<typeof agentFixture>>;

it("pages run summaries, views and records identically over MCP and the CLI", async () => {
  const f = await agentFixture();
  const root = mkdtempSync(join(tmpdir(), "tracker-run-pages-"));
  try {
    const { run, terminal } = seed(f.context, root);
    const cli = (args: string[]) => JSON.parse(f.cli([...args, "--json"]));

    // Run list pages: same bounded summaries and cursors on both surfaces.
    const first = await f.call("list_runs", { limit: 5 });
    expect(first.error).toBe(false);
    expect(first.data.runs).toHaveLength(5);
    expect(first.data.runs[0]).not.toHaveProperty("resolvedConfiguration");
    expect(cli(["run", "list", "--limit", "5"])).toEqual(first.data);
    const second = await f.call("list_runs", { limit: 5, cursor: first.data.nextCursor });
    expect(cli(["run", "list", "--limit", "5", "--cursor", first.data.nextCursor])).toEqual(second.data);
    expect((await f.call("list_runs", {})).data.runs).toHaveLength(25);

    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: { runs: Array<{ id: string }>; nextCursor: string | null } } = await f.call("list_runs", { limit: 7, ...(cursor ? { cursor } : {}) });
      walked.push(...page.data.runs.map((summary) => summary.id));
      cursor = page.data.nextCursor;
    } while (cursor);
    expect(walked).toEqual(listRuns(f.context).map((candidate) => candidate.id));

    // Views: full stays the default; summary is compact.
    const summary = await f.call("get_run", { run: run.id, view: "summary" });
    expect(summary.data).toMatchObject({ id: run.id, state: "queued", archivedAt: null, completedAt: null });
    expect(summary.data).not.toHaveProperty("resolvedConfiguration");
    expect(cli(["run", "view", run.id, "--view", "summary"])).toEqual(summary.data);
    const full = await f.call("get_run", { run: run.id });
    expect(full.data).toHaveProperty("resolvedConfiguration");
    expect(cli(["run", "view", run.id])).toEqual(full.data);

    // Independently paged records.
    const participants = await f.call("list_run_records", { run: run.id, collection: "participants", limit: 2 });
    expect(participants.data.items).toHaveLength(2);
    expect(cli(["run", "records", run.id, "participants", "--limit", "2"])).toEqual(participants.data);
    const nextParticipants = await f.call("list_run_records", { run: run.id, collection: "participants", limit: 2, cursor: participants.data.nextCursor });
    expect(cli(["run", "records", run.id, "participants", "--limit", "2", "--cursor", participants.data.nextCursor])).toEqual(nextParticipants.data);
    const artifacts = await f.call("list_run_artifacts", { run: run.id, limit: 10 });
    expect(artifacts.data).toMatchObject({ run: run.id, collection: "artifacts" });
    expect(artifacts.data.items).toHaveLength(10);
    expect(cli(["run", "artifacts", run.id, "--limit", "10"])).toEqual(artifacts.data);
    expect((await f.call("list_run_records", { run: run.id, collection: "artifacts", limit: 10 })).data).toEqual(artifacts.data);
    const allArtifacts: unknown[] = [];
    cursor = null;
    do {
      const page: { data: { items: unknown[]; nextCursor: string | null } } = await f.call("list_run_artifacts", { run: run.id, limit: 100, ...(cursor ? { cursor } : {}) });
      allArtifacts.push(...page.data.items);
      cursor = page.data.nextCursor;
    } while (cursor);
    expect(allArtifacts).toEqual(JSON.parse(JSON.stringify(getRun(f.context, run.id).artifacts)));

    // Compact mutation responses match a subsequent summary read on the other surface.
    const archived = await f.call("archive_run", { run: terminal[0], view: "summary" });
    expect(archived.error).toBe(false);
    expect(archived.data.archivedAt).toEqual(expect.any(String));
    expect(archived.data).not.toHaveProperty("resolvedConfiguration");
    expect(cli(["run", "view", terminal[0]!, "--view", "summary"])).toEqual(archived.data);
    const cliArchived = cli(["run", "archive", terminal[1]!, "--view", "summary"]);
    expect((await f.call("get_run", { run: terminal[1], view: "summary" })).data).toEqual(cliArchived);
    const stopped = await f.call("stop_run", { run: run.id, view: "summary" });
    expect(stopped.data.pending.actions).toBe(summary.data.pending.actions + 1);
    expect(cli(["run", "view", run.id, "--view", "summary"])).toEqual(stopped.data);
  } finally { rmSync(root, { recursive: true, force: true }); await f.close(); }
});

it("returns compact retry responses identically over MCP and the CLI", async () => {
  const f = await agentFixture();
  const root = mkdtempSync(join(tmpdir(), "tracker-run-pages-"));
  try {
    const { terminal } = seed(f.context, root);
    const cli = (args: string[]) => JSON.parse(f.cli([...args, "--json"]));
    const client = (f.context.db as unknown as { $client: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).$client;
    const retryProject = createProject(f.context, { name: "Fictional Retries" });
    const block = client.prepare("UPDATE agent_runs SET issue_id = ?, state = 'blocked', completed_at = NULL, outcome = NULL WHERE id = ?");
    block.run(createIssue(f.context, { title: "Retry fictional build", projectId: retryProject.id }).id, terminal[2]);
    block.run(createIssue(f.context, { title: "Retry fictional deploy", projectId: retryProject.id }).id, terminal[3]);
    const retried = await f.call("retry_run", { run: terminal[2], view: "summary" });
    expect(retried.error).toBe(false);
    expect(retried.data).toMatchObject({ id: terminal[2], state: "running" });
    expect(retried.data).not.toHaveProperty("resolvedConfiguration");
    expect(cli(["run", "view", terminal[2]!, "--view", "summary"])).toEqual(retried.data);
    const cliRetried = cli(["run", "retry", terminal[3]!, "--view", "summary"]);
    expect(cliRetried).not.toHaveProperty("resolvedConfiguration");
    expect((await f.call("get_run", { run: terminal[3], view: "summary" })).data).toEqual(cliRetried);
  } finally { rmSync(root, { recursive: true, force: true }); await f.close(); }
});

it("returns identical error envelopes for bad cursors, unknown runs and invalid collections", async () => {
  const f = await agentFixture();
  const root = mkdtempSync(join(tmpdir(), "tracker-run-pages-"));
  try {
    const { run } = seed(f.context, root);
    const missing = randomUUID();
    await expectParity(f, "list_runs", { cursor: "garbage" }, ["run", "list", "--cursor", "garbage"], "VALIDATION_FAILED");
    const filtered = (await f.call("list_runs", { state: "failed", limit: 2 })).data.nextCursor as string;
    await expectParity(f, "list_runs", { cursor: filtered, limit: 2 }, ["run", "list", "--cursor", filtered, "--limit", "2"], "VALIDATION_FAILED");
    await expectParity(f, "list_runs", { limit: 101 }, ["run", "list", "--limit", "101"], "VALIDATION_FAILED");
    await expectParity(f, "get_run", { run: missing, view: "summary" }, ["run", "view", missing, "--view", "summary"], "RUN_NOT_FOUND");
    await expectParity(f, "list_run_records", { run: missing, collection: "artifacts" }, ["run", "records", missing, "artifacts"], "RUN_NOT_FOUND");
    await expectParity(f, "list_run_records", { run: run.id, collection: "bogus" }, ["run", "records", run.id, "bogus"], "VALIDATION_FAILED");
    const artifactCursor = (await f.call("list_run_artifacts", { run: run.id, limit: 1 })).data.nextCursor as string;
    await expectParity(f, "list_run_records", { run: run.id, collection: "participants", cursor: artifactCursor }, ["run", "records", run.id, "participants", "--cursor", artifactCursor], "VALIDATION_FAILED");
  } finally { rmSync(root, { recursive: true, force: true }); await f.close(); }
});

async function expectParity(f: Fixture, tool: string, args: Record<string, unknown>, cliArgs: string[], code: string) {
  const result = await f.call(tool, args);
  expect(result.error, tool).toBe(true);
  expect(result.data.error.code, tool).toBe(code);
  expect(f.cliError([...cliArgs, "--json"])).toEqual(result.data.error);
}

function seed(context: ServiceContext, root: string) {
  const project = createProject(context, { name: "Fictional Delivery" });
  const issue = createIssue(context, { title: "Set up CI", projectId: project.id });
  const other = createIssue(context, { title: "Write fictional docs", projectId: project.id });
  const repository = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), "# Fictional repository\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fictional User", "-c", "user.email=fictional@example.test", "commit", "-q", "-m", "Set up fictional repository"]);
  const registered = addRepository(context, { name: "Primary", path: repository, testCommand: { executable: "node", args: ["--test"], envNames: [] }, verificationCommand: { executable: "npm", args: ["run", "typecheck"], envNames: [] } }, createNodeRepositoryInspector());
  associateRepository(context, { repository: registered.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
  const runtime = { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data") };
  const preview = previewRun(context, { issue: issue.identifier }, runtime);
  const run = startRun(context, { issue: issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);

  const client = (context.db as unknown as { $client: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).$client;
  const insertRun = client.prepare(`INSERT INTO agent_runs (id, issue_id, profile_id, workflow, workflow_version, schema_version, resolved_configuration, phase, state, primary_repository_id, base_ref, base_commit, branch, worktree_path, parallel_group, event_counter, attempt_counter, started_at, last_event_at, last_progress_at, completed_at, outcome, error, archived_at, created_at, updated_at)
    VALUES (?, ?, NULL, 'fictional-flow', 1, 1, ?, 'implement', 'failed', ?, 'main', ?, ?, ?, NULL, 2, 1, ?, ?, ?, ?, 'failed', ?, NULL, ?, ?)`);
  const terminal: string[] = [];
  for (let index = 0; index < 60; index += 1) {
    const id = randomUUID();
    const at = new Date(Date.parse("2025-12-01T00:00:00.000Z") + Math.floor(index / 3) * 60_000).toISOString();
    insertRun.run(id, index % 2 === 0 ? issue.id : other.id, JSON.stringify(run.resolvedConfiguration), registered.id, "0".repeat(40), `fictional/run-${index}`, `/fictional/worktrees/run-${index}`, at, at, at, at, JSON.stringify({ code: "fictional_failure" }), at, at);
    terminal.push(id);
  }
  const insertArtifact = client.prepare(`INSERT INTO run_artifacts (id, run_id, attempt_id, kind, title, local_path, url, sha256, metadata, attachment_id, removed_at, created_at) VALUES (?, ?, NULL, 'log', ?, NULL, NULL, NULL, ?, NULL, NULL, ?)`);
  for (let index = 0; index < 130; index += 1) {
    insertArtifact.run(randomUUID(), run.id, `Fictional artifact ${index}`, JSON.stringify({ index }), new Date(Date.parse("2026-01-01T00:00:00.000Z") + Math.floor(index / 5) * 1000).toISOString());
  }
  return { run, terminal };
}
