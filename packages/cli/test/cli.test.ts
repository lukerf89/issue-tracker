import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { openDb } from "@issue-tracker/core";

import { createProgram, resolveWatchOptions, run } from "../src/index.js";

const tempDirs: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const builtCliPath = join(repoRoot, "packages/cli/dist/index.js");

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("tracker CLI", () => {
  it("runs the built CLI when invoked through a symlinked bin path", () => {
    buildCliPackage();

    const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-cli-bin-"));
    tempDirs.push(tempDir);
    const linkedBinPath = join(tempDir, "tracker-linked");
    symlinkSync(builtCliPath, linkedBinPath);

    const stdout = execFileSync(process.execPath, [linkedBinPath, "--version"], {
      encoding: "utf8"
    });

    expect(stdout).toBe("0.1.1\n");
  });

  it("prints the package version cleanly for long and short flags", async () => {
    const dbPath = tempDbPath();

    for (const flag of ["--version", "-V"]) {
      const result = await tracker(dbPath, [flag]);

      expect(result).toEqual({
        status: 0,
        stdout: "0.1.1\n",
        stderr: ""
      });
    }
  });

  it("prints top-level help cleanly", async () => {
    const dbPath = tempDbPath();
    const result = await tracker(dbPath, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: tracker [options] [command]");
    expect(result.stdout).toContain("issue");
    expect(result.stdout).not.toContain("\"error\"");
  });

  it("prints the LF-57 command surface in help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: tracker [options] [command]");
    expect(help).toContain("issue");
    expect(help).toContain("project");
    expect(help).toContain("team");
    expect(help).toContain("tui");
  });

  it("initializes a temp DB, creates a project and issue, and lists JSON records", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect(
      (await tracker(dbPath, ["project", "create", "Platform Foundations", "--status", "planned"]))
        .status
    ).toBe(0);
    expect(
      (await tracker(dbPath, [
        "issue",
        "create",
        "--title",
        "Set up CI",
        "--project",
        "Platform Foundations",
        "--priority",
        "2"
      ])).status
    ).toBe(0);

    const list = await tracker(dbPath, ["issue", "list", "--json"]);
    expect(list.status).toBe(0);

    const records = JSON.parse(list.stdout) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      identifier: "ENG-1",
      title: "Set up CI",
      priority: 2,
      description: null,
      assigneeId: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null
    });
    expect(records[0]?.projectId).toEqual(expect.any(String));
  });

  it("sets default actor and team config from friendly handles and keys", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "actor",
          "create",
          "build-agent",
          "Build Agent",
          "--type",
          "agent"
        ])
      ).status
    ).toBe(0);
    expect((await tracker(dbPath, ["team", "create", "OPS", "Operations"])).status).toBe(0);

    const actorConfig = await tracker(dbPath, ["config", "set", "actor", "build-agent", "--json"]);
    expect(actorConfig.status).toBe(0);
    const actorConfigJson = JSON.parse(actorConfig.stdout) as Record<string, unknown>;
    expect(actorConfigJson).toMatchObject({ key: "default_actor" });
    expect(actorConfigJson.value).not.toBe("build-agent");

    const who = await tracker(dbPath, ["whoami", "--json"]);
    expect(JSON.parse(who.stdout)).toMatchObject({ handle: "build-agent" });

    const teamConfig = await tracker(dbPath, ["config", "set", "team", "ops", "--json"]);
    expect(teamConfig.status).toBe(0);
    const teamConfigJson = JSON.parse(teamConfig.stdout) as Record<string, unknown>;
    expect(teamConfigJson).toMatchObject({ key: "default_team" });
    expect(teamConfigJson.value).not.toBe("ops");

    const issue = await tracker(dbPath, ["issue", "create", "--title", "Route ops work", "--json"]);
    expect(JSON.parse(issue.stdout)).toMatchObject({
      identifier: "OPS-1",
      creatorId: actorConfigJson.value
    });
  });

  it("backs up a live database with a restorable copy", async () => {
    const dbPath = tempDbPath();
    const backupPath = join(dirname(dbPath), "tracker-backup-test.db");

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Back up live data"])).status).toBe(
      0
    );

    const liveDb = openDb(dbPath);

    try {
      expect(
        liveDb.$client
          .prepare("select title from issues where identifier = ?")
          .get("ENG-1")
      ).toEqual({ title: "Back up live data" });

      const result = await tracker(dbPath, ["backup", "--output", backupPath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${backupPath}\n`);
      expect(existsSync(backupPath)).toBe(true);

      const backupDb = openDb(backupPath);

      try {
        expect(
          backupDb.$client
            .prepare("select title from issues where identifier = ?")
            .get("ENG-1")
        ).toEqual({ title: "Back up live data" });
      } finally {
        backupDb.$client.close();
      }
    } finally {
      liveDb.$client.close();
    }
  });

  it("exports the workspace snapshot JSON to stdout or an output file", async () => {
    const dbPath = tempDbPath();
    const outputPath = join(dirname(dbPath), "snapshot.json");

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["label", "create", "Docs", "--color", "#22C55E"])).status).toBe(
      0
    );
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Export workspace data",
          "--label",
          "Docs"
        ])
      ).status
    ).toBe(0);
    expect(
      (await tracker(dbPath, ["issue", "comment", "ENG-1", "Snapshot is readable."])).status
    ).toBe(0);

    const exported = await tracker(dbPath, ["export", "--json"]);
    expect(exported.status).toBe(0);

    const snapshot = JSON.parse(exported.stdout) as {
      workspace: { name: string };
      config: Array<{ key: string }>;
      teams: Array<{ key: string }>;
      workflowStates: Array<{ name: string }>;
      projects: unknown[];
      milestones: unknown[];
      cycles: unknown[];
      issues: Array<{ identifier: string; title: string }>;
      labels: Array<{ name: string; group: string | null }>;
      issueLabels: Array<{ issueId: string; labelId: string }>;
      comments: Array<{ body: string; parentId: string | null }>;
      actors: Array<{ handle: string }>;
      attachments: unknown[];
      activity: Array<{ action: string; data: Record<string, unknown> }>;
      savedViews: unknown[];
      templates: unknown[];
    };

    expect(Object.keys(snapshot)).toEqual([
      "workspace",
      "config",
      "teams",
      "workflowStates",
      "projects",
      "milestones",
      "cycles",
      "issues",
      "labels",
      "issueLabels",
      "issueDependencies",
      "comments",
      "actors",
      "attachments",
      "activity",
      "savedViews",
      "templates"
    ]);
    expect(snapshot.workspace.name).toBe("Local Workspace");
    expect(snapshot.config.map((entry) => entry.key)).toEqual([
      "default_actor",
      "default_team"
    ]);
    expect(snapshot.teams.map((team) => team.key)).toEqual(["ENG"]);
    expect(snapshot.workflowStates.map((state) => state.name)).toContain("Todo");
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.milestones).toEqual([]);
    expect(snapshot.cycles).toEqual([]);
    expect(snapshot.issues.map((issue) => [issue.identifier, issue.title])).toEqual([
      ["ENG-1", "Export workspace data"]
    ]);
    expect(snapshot.labels).toMatchObject([{ name: "Docs", group: null }]);
    expect(snapshot.issueLabels).toHaveLength(1);
    expect(snapshot.comments).toMatchObject([
      { body: "Snapshot is readable.", parentId: null }
    ]);
    expect(snapshot.actors.map((actor) => actor.handle)).toEqual(["owner"]);
    expect(snapshot.attachments).toEqual([]);
    expect(snapshot.activity.map((entry) => entry.action)).toEqual([
      "created",
      "label_added",
      "commented"
    ]);
    expect(snapshot.savedViews).toEqual([]);
    expect(snapshot.templates).toEqual([]);
    expect(snapshot.activity[0]?.data).toMatchObject({ identifier: "ENG-1" });
    expect(exported.stdout).not.toContain("undefined");

    const written = await tracker(dbPath, ["export", "--json", "--output", outputPath]);
    expect(written.status).toBe(0);
    expect(written.stdout).toBe("");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      issues: [{ identifier: "ENG-1", title: "Export workspace data" }],
      labels: [{ name: "Docs" }],
      comments: [{ body: "Snapshot is readable." }]
    });
  });

  it("imports an exported snapshot into a fresh DB and guards non-empty DBs", async () => {
    const sourceDbPath = tempDbPath();
    const destinationDbPath = tempDbPath();
    const outputPath = join(dirname(sourceDbPath), "snapshot-import.json");

    expect((await tracker(sourceDbPath, ["init"])).status).toBe(0);

    const agentResult = await tracker(sourceDbPath, [
      "actor",
      "create",
      "build-agent",
      "Build Agent",
      "--type",
      "agent",
      "--json"
    ]);
    expect(agentResult.status).toBe(0);
    const agent = JSON.parse(agentResult.stdout) as { id: string };

    expect(
      (
        await tracker(sourceDbPath, [
          "project",
          "create",
          "Platform Foundations",
          "--status",
          "planned",
          "--lead-id",
          agent.id
        ])
      ).status
    ).toBe(0);
    expect((await tracker(sourceDbPath, ["label", "create", "Bug", "--color", "#EF4444"])).status)
      .toBe(0);
    expect(
      (
        await tracker(sourceDbPath, [
          "issue",
          "create",
          "--title",
          "Import parent issue",
          "--project",
          "Platform Foundations"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(sourceDbPath, [
          "issue",
          "create",
          "--title",
          "Import child issue",
          "--parent",
          "ENG-1",
          "--assignee",
          "build-agent",
          "--project",
          "Platform Foundations",
          "--label",
          "Bug"
        ])
      ).status
    ).toBe(0);

    const comment = await tracker(sourceDbPath, [
      "issue",
      "comment",
      "ENG-2",
      "Import keeps comments.",
      "--json"
    ]);
    expect(comment.status).toBe(0);
    const commentId = (JSON.parse(comment.stdout) as { id: string }).id;

    expect(
      (
        await tracker(sourceDbPath, [
          "issue",
          "comment",
          "ENG-2",
          "Import keeps replies.",
          "--parent",
          commentId
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(sourceDbPath, [
          "issue",
          "link",
          "ENG-2",
          "--kind",
          "pr",
          "--repo",
          "/fictional/repo",
          "--url",
          "https://example.invalid/pr/89",
          "--title",
          "Import PR"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(sourceDbPath, [
          "view",
          "save",
          "Import bugs",
          "--label",
          "Bug",
          "--priority",
          "0"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(sourceDbPath, [
          "template",
          "create",
          "Import task",
          "--title",
          "Plan import",
          "--project",
          "Platform Foundations",
          "--label",
          "Bug"
        ])
      ).status
    ).toBe(0);

    const written = await tracker(sourceDbPath, ["export", "--json", "--output", outputPath]);
    expect(written.status).toBe(0);
    const snapshot = JSON.parse(readFileSync(outputPath, "utf8"));

    const imported = await tracker(destinationDbPath, ["import", "--input", outputPath]);
    expect(imported.status).toBe(0);
    expect(imported.stdout).toContain("Imported 1 workspace");
    expect(imported.stdout).toContain("2 issues");

    const reexported = await tracker(destinationDbPath, ["export", "--json"]);
    expect(reexported.status).toBe(0);
    expect(JSON.parse(reexported.stdout)).toEqual(snapshot);

    const refused = await tracker(destinationDbPath, ["import", "--input", outputPath]);
    expect(refused.status).not.toBe(0);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      error: {
        code: "CONSTRAINT_VIOLATION",
        details: { force: true }
      }
    });

    const forced = await tracker(destinationDbPath, [
      "import",
      "--input",
      outputPath,
      "--force",
      "--json"
    ]);
    expect(forced.status).toBe(0);
    expect(JSON.parse(forced.stdout)).toMatchObject({ issues: 2, comments: 2 });
  });

  it("creates and lists actors, assigns by handle, clears with --none, and assigns --me", async () => {
    const dbPath = tempDbPath();

    const initialized = await tracker(dbPath, ["init", "--json"]);
    expect(initialized.status).toBe(0);
    const defaultActor = (JSON.parse(initialized.stdout) as { actor: { id: string } }).actor;

    const actorResult = await tracker(dbPath, [
      "actor",
      "create",
      "build-agent",
      "Build Agent",
      "--type",
      "agent",
      "--json"
    ]);
    expect(actorResult.status).toBe(0);
    const agent = JSON.parse(actorResult.stdout) as { id: string; handle: string; type: string };
    expect(agent).toMatchObject({
      handle: "build-agent",
      type: "agent",
      archivedAt: null
    });

    const actors = await tracker(dbPath, ["actor", "list", "--json"]);
    expect(actors.status).toBe(0);
    expect(
      (JSON.parse(actors.stdout) as Array<{ handle: string; type: string }>).map((actor) => [
        actor.handle,
        actor.type
      ])
    ).toEqual([
      ["build-agent", "agent"],
      ["owner", "human"]
    ]);

    expect((await tracker(dbPath, ["issue", "create", "--title", "Route CLI work"])).status).toBe(
      0
    );

    const assigned = await tracker(dbPath, [
      "issue",
      "assign",
      "ENG-1",
      "build-agent",
      "--json"
    ]);
    expect(assigned.status).toBe(0);
    expect(JSON.parse(assigned.stdout)).toMatchObject({
      identifier: "ENG-1",
      assigneeId: agent.id
    });

    const filtered = await tracker(dbPath, [
      "issue",
      "list",
      "--assignee",
      "build-agent",
      "--json"
    ]);
    expect(filtered.status).toBe(0);
    expect(
      (JSON.parse(filtered.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-1"]);

    const cleared = await tracker(dbPath, ["issue", "assign", "ENG-1", "--none", "--json"]);
    expect(cleared.status).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      identifier: "ENG-1",
      assigneeId: null
    });

    const assignedToMe = await tracker(dbPath, ["issue", "assign", "ENG-1", "--me", "--json"]);
    expect(assignedToMe.status).toBe(0);
    expect(JSON.parse(assignedToMe.stdout)).toMatchObject({
      identifier: "ENG-1",
      assigneeId: defaultActor.id
    });
  });

  it("moves an issue to a new workflow state", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect(
      (await tracker(dbPath, ["issue", "create", "--title", "Implement lifecycle states"])).status
    ).toBe(0);

    const moved = await tracker(dbPath, ["issue", "move", "ENG-1", "In Progress", "--json"]);
    expect(moved.status).toBe(0);

    const movedIssue = JSON.parse(moved.stdout) as Record<string, unknown>;
    expect(movedIssue.startedAt).toEqual(expect.any(String));

    const started = await tracker(dbPath, ["issue", "list", "--state", "In Progress", "--json"]);
    expect(started.status).toBe(0);

    const records = JSON.parse(started.stdout) as Array<Record<string, unknown>>;
    expect(records.map((record) => record.identifier)).toEqual(["ENG-1"]);
  });

  it("clears nullable issue fields with no-option flags", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["cycle", "create", "Sprint 1"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Clear issue fields"])).status).toBe(
      0
    );

    const populated = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-1",
      "--cycle",
      "1",
      "--estimate",
      "3",
      "--due-date",
      "2026-08-01",
      "--json"
    ]);
    expect(populated.status).toBe(0);
    expect(JSON.parse(populated.stdout)).toMatchObject({
      cycleId: expect.any(String),
      estimate: 3,
      dueDate: "2026-08-01"
    });

    const cleared = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-1",
      "--no-cycle",
      "--no-estimate",
      "--no-due-date",
      "--json"
    ]);
    expect(cleared.status).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      cycleId: null,
      estimate: null,
      dueDate: null
    });
  });

  it("filters issue list JSON by priority", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Fix release blocker",
          "--priority",
          "1"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Tidy help output",
          "--priority",
          "4"
        ])
      ).status
    ).toBe(0);

    const filtered = await tracker(dbPath, ["issue", "list", "--priority", "1", "--json"]);
    expect(filtered.status).toBe(0);

    const records = JSON.parse(filtered.stdout) as Array<Record<string, unknown>>;
    expect(records.map((record) => record.identifier)).toEqual(["ENG-1"]);
    expect(records.map((record) => record.priority)).toEqual([1]);
  });

  it("saves, lists, applies, overrides, and deletes named issue filter views", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["label", "create", "Bug", "--color", "#EF4444"])).status).toBe(
      0
    );
    expect((await tracker(dbPath, ["label", "create", "Docs", "--color", "#22C55E"])).status).toBe(
      0
    );
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Fix active bug",
          "--priority",
          "1",
          "--label",
          "Bug"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Fix later bug",
          "--priority",
          "2",
          "--label",
          "Bug"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Refresh docs",
          "--priority",
          "1",
          "--label",
          "Docs"
        ])
      ).status
    ).toBe(0);

    const saved = await tracker(dbPath, [
      "view",
      "save",
      "Priority bugs",
      "--label",
      "Bug",
      "--priority",
      "1",
      "--json"
    ]);
    expect(saved.status).toBe(0);
    expect(JSON.parse(saved.stdout)).toMatchObject({
      name: "Priority bugs",
      filters: { label: "Bug", priority: 1 },
      description: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String)
    });

    const listedViews = await tracker(dbPath, ["view", "list", "--json"]);
    expect(listedViews.status).toBe(0);
    expect(
      (JSON.parse(listedViews.stdout) as Array<{ name: string }>).map((view) => view.name)
    ).toEqual(["Priority bugs"]);

    const fromView = await tracker(dbPath, [
      "issue",
      "list",
      "--view",
      "Priority bugs",
      "--json"
    ]);
    expect(fromView.status).toBe(0);
    expect(
      (JSON.parse(fromView.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-1"]);

    const overridden = await tracker(dbPath, [
      "issue",
      "list",
      "--view",
      "Priority bugs",
      "--priority",
      "2",
      "--json"
    ]);
    expect(overridden.status).toBe(0);
    expect(
      (JSON.parse(overridden.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-2"]);

    const duplicate = await tracker(dbPath, [
      "view",
      "save",
      "Priority bugs",
      "--state",
      "Todo",
      "--json"
    ]);
    expect(duplicate.status).not.toBe(0);
    expect(JSON.parse(duplicate.stderr)).toMatchObject({
      error: { code: "SAVED_VIEW_NAME_TAKEN" }
    });

    const deleted = await tracker(dbPath, ["view", "delete", "Priority bugs", "--json"]);
    expect(deleted.status).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      name: "Priority bugs",
      filters: { label: "Bug", priority: 1 }
    });

    const viewsAfterDelete = await tracker(dbPath, ["view", "list", "--json"]);
    expect(viewsAfterDelete.status).toBe(0);
    expect(JSON.parse(viewsAfterDelete.stdout)).toEqual([]);
  });

  it("creates, lists, applies overrides, and deletes issue templates", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["label", "create", "Bug", "--color", "#EF4444"])).status).toBe(
      0
    );
    const projectResult = await tracker(dbPath, [
      "project",
      "create",
      "Platform Foundations",
      "--status",
      "planned",
      "--json"
    ]);
    expect(projectResult.status).toBe(0);
    const project = JSON.parse(projectResult.stdout) as { id: string };

    const createdTemplate = await tracker(dbPath, [
      "template",
      "create",
      "Bug report",
      "--title",
      "Investigate fictional bug",
      "--desc",
      "Capture reproduction steps.",
      "--priority",
      "2",
      "--team",
      "ENG",
      "--project",
      "Platform Foundations",
      "--label",
      "Bug",
      "--json"
    ]);
    expect(createdTemplate.status).toBe(0);
    expect(JSON.parse(createdTemplate.stdout)).toMatchObject({
      name: "Bug report",
      title: "Investigate fictional bug",
      description: "Capture reproduction steps.",
      priority: 2,
      team: "ENG",
      project: project.id,
      labels: ["Bug"],
      createdAt: expect.any(String),
      updatedAt: expect.any(String)
    });

    const listedTemplates = await tracker(dbPath, ["template", "list", "--json"]);
    expect(listedTemplates.status).toBe(0);
    expect(
      (JSON.parse(listedTemplates.stdout) as Array<{ name: string }>).map(
        (template) => template.name
      )
    ).toEqual(["Bug report"]);

    const issue = await tracker(dbPath, [
      "issue",
      "create",
      "--template",
      "Bug report",
      "--title",
      "Investigate export bug",
      "--priority",
      "1",
      "--json"
    ]);
    expect(issue.status).toBe(0);
    const createdIssue = JSON.parse(issue.stdout) as {
      identifier: string;
      title: string;
      description: string | null;
      priority: number;
      labels: Array<{ name: string }>;
    };
    expect(createdIssue).toMatchObject({
      identifier: "ENG-1",
      title: "Investigate export bug",
      description: "Capture reproduction steps.",
      priority: 1
    });
    expect(createdIssue.labels.map((label) => label.name)).toEqual(["Bug"]);

    const activity = await tracker(dbPath, ["issue", "history", "ENG-1", "--json"]);
    expect(activity.status).toBe(0);
    expect(
      (JSON.parse(activity.stdout) as Array<{ action: string }>).map((entry) => entry.action)
    ).toEqual(["created", "label_added"]);

    const duplicate = await tracker(dbPath, [
      "template",
      "create",
      "Bug report",
      "--title",
      "Duplicate template",
      "--json"
    ]);
    expect(duplicate.status).not.toBe(0);
    expect(JSON.parse(duplicate.stderr)).toMatchObject({
      error: { code: "TEMPLATE_NAME_TAKEN" }
    });

    const deleted = await tracker(dbPath, ["template", "delete", "Bug report", "--json"]);
    expect(deleted.status).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      name: "Bug report",
      labels: ["Bug"]
    });

    const templatesAfterDelete = await tracker(dbPath, ["template", "list", "--json"]);
    expect(templatesAfterDelete.status).toBe(0);
    expect(JSON.parse(templatesAfterDelete.stdout)).toEqual([]);
  });

  it("searches issues as JSON by title and description, hides archived issues, and supports team and limit filters", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["team", "create", "OPS", "Operations"])).status).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Fix Login Redirect",
          "--desc",
          "OAuth callback fails"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Refresh setup guide",
          "--desc",
          "Mention login redirect setup"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--team",
          "OPS",
          "--title",
          "Login operations runbook"
        ])
      ).status
    ).toBe(0);
    expect(
      (await tracker(dbPath, ["issue", "create", "--title", "Archived login cleanup"])).status
    ).toBe(0);
    expect((await tracker(dbPath, ["issue", "archive", "ENG-3"])).status).toBe(0);

    const searched = await tracker(dbPath, ["issue", "search", "LOGIN", "--json"]);
    expect(searched.status).toBe(0);
    const records = JSON.parse(searched.stdout) as Array<Record<string, unknown>>;
    expect(records.map((record) => record.identifier)).toEqual(["ENG-1", "ENG-2", "OPS-1"]);
    expect(records.map((record) => record.archivedAt)).toEqual([null, null, null]);

    const operations = await tracker(dbPath, [
      "issue",
      "search",
      "login",
      "--team",
      "OPS",
      "--json"
    ]);
    expect(operations.status).toBe(0);
    expect(
      (JSON.parse(operations.stdout) as Array<Record<string, unknown>>).map(
        (record) => record.identifier
      )
    ).toEqual(["OPS-1"]);

    const limited = await tracker(dbPath, ["issue", "search", "login", "--limit", "2", "--json"]);
    expect(limited.status).toBe(0);
    expect(
      (JSON.parse(limited.stdout) as Array<Record<string, unknown>>).map(
        (record) => record.identifier
      )
    ).toEqual(["ENG-1", "ENG-2"]);
  });

  it("archives issues, hides them from list by default, includes them on request, and still views them", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Archive completed work"])).status).toBe(
      0
    );
    expect((await tracker(dbPath, ["issue", "create", "--title", "Keep active work"])).status).toBe(
      0
    );

    const archived = await tracker(dbPath, ["issue", "archive", "ENG-1", "--json"]);
    expect(archived.status).toBe(0);
    expect(JSON.parse(archived.stdout)).toMatchObject({
      identifier: "ENG-1",
      archivedAt: expect.any(String)
    });

    const visible = await tracker(dbPath, ["issue", "list", "--json"]);
    expect(visible.status).toBe(0);
    expect(
      (JSON.parse(visible.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-2"]);

    const all = await tracker(dbPath, ["issue", "list", "--include-archived", "--json"]);
    expect(all.status).toBe(0);
    expect(
      (JSON.parse(all.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-1", "ENG-2"]);

    const viewed = await tracker(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(viewed.status).toBe(0);
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      identifier: "ENG-1",
      archivedAt: expect.any(String)
    });

    const restored = await tracker(dbPath, ["issue", "unarchive", "ENG-1", "--json"]);
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      identifier: "ENG-1",
      archivedAt: null
    });

    const visibleAgain = await tracker(dbPath, ["issue", "list", "--json"]);
    expect(visibleAgain.status).toBe(0);
    expect(
      (JSON.parse(visibleAgain.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-1", "ENG-2"]);
  });

  it("archives and unarchives teams and projects through CLI list flows", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["team", "create", "OPS", "Operations"])).status).toBe(0);

    const createdProject = await tracker(dbPath, [
      "project",
      "create",
      "Platform Foundations",
      "--status",
      "planned",
      "--json"
    ]);
    expect(createdProject.status).toBe(0);
    const project = JSON.parse(createdProject.stdout) as { id: string; name: string };

    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--team",
          "OPS",
          "--title",
          "Keep related issue addressable",
          "--project",
          project.name
        ])
      ).status
    ).toBe(0);

    const archivedTeam = await tracker(dbPath, ["team", "archive", "OPS", "--json"]);
    expect(archivedTeam.status).toBe(0);
    expect(JSON.parse(archivedTeam.stdout)).toMatchObject({
      key: "OPS",
      archivedAt: expect.any(String)
    });

    const archivedProject = await tracker(dbPath, [
      "project",
      "archive",
      project.name,
      "--json"
    ]);
    expect(archivedProject.status).toBe(0);
    expect(JSON.parse(archivedProject.stdout)).toMatchObject({
      id: project.id,
      archivedAt: expect.any(String)
    });

    const visibleTeams = await tracker(dbPath, ["team", "list", "--json"]);
    expect(visibleTeams.status).toBe(0);
    expect(
      (JSON.parse(visibleTeams.stdout) as Array<Record<string, unknown>>).map((team) => team.key)
    ).toEqual(["ENG"]);

    const allTeams = await tracker(dbPath, ["team", "list", "--include-archived", "--json"]);
    expect(allTeams.status).toBe(0);
    expect(
      (JSON.parse(allTeams.stdout) as Array<Record<string, unknown>>).map((team) => team.key)
    ).toEqual(["ENG", "OPS"]);

    const visibleProjects = await tracker(dbPath, ["project", "list", "--json"]);
    expect(visibleProjects.status).toBe(0);
    expect(JSON.parse(visibleProjects.stdout)).toEqual([]);

    const allProjects = await tracker(dbPath, [
      "project",
      "list",
      "--include-archived",
      "--json"
    ]);
    expect(allProjects.status).toBe(0);
    expect(
      (JSON.parse(allProjects.stdout) as Array<Record<string, unknown>>).map(
        (item) => item.id
      )
    ).toEqual([project.id]);

    const issueView = await tracker(dbPath, ["issue", "view", "OPS-1", "--json"]);
    expect(issueView.status).toBe(0);
    expect(JSON.parse(issueView.stdout)).toMatchObject({
      identifier: "OPS-1",
      projectId: project.id
    });

    const restoredTeam = await tracker(dbPath, ["team", "unarchive", "OPS", "--json"]);
    expect(restoredTeam.status).toBe(0);
    expect(JSON.parse(restoredTeam.stdout)).toMatchObject({
      key: "OPS",
      archivedAt: null
    });

    const restoredProject = await tracker(dbPath, [
      "project",
      "unarchive",
      project.id,
      "--json"
    ]);
    expect(restoredProject.status).toBe(0);
    expect(JSON.parse(restoredProject.stdout)).toMatchObject({
      id: project.id,
      archivedAt: null
    });

    const teamsAfterRestore = await tracker(dbPath, ["team", "list", "--json"]);
    expect(teamsAfterRestore.status).toBe(0);
    expect(
      (JSON.parse(teamsAfterRestore.stdout) as Array<Record<string, unknown>>).map(
        (team) => team.key
      )
    ).toEqual(["ENG", "OPS"]);

    const projectsAfterRestore = await tracker(dbPath, ["project", "list", "--json"]);
    expect(projectsAfterRestore.status).toBe(0);
    expect(
      (JSON.parse(projectsAfterRestore.stdout) as Array<Record<string, unknown>>).map(
        (item) => item.id
      )
    ).toEqual([project.id]);
  });

  it("creates and clears sub-issues through parent flags and shows relationships in view JSON", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const parentResult = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Build issue hierarchy",
      "--json"
    ]);
    expect(parentResult.status).toBe(0);
    const parent = JSON.parse(parentResult.stdout) as Record<string, unknown>;

    const childResult = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Add child issue",
      "--parent",
      "ENG-1",
      "--json"
    ]);
    expect(childResult.status).toBe(0);
    const child = JSON.parse(childResult.stdout) as Record<string, unknown>;
    expect(child).toMatchObject({
      identifier: "ENG-2",
      parentId: parent.id,
      parent: { identifier: "ENG-1" }
    });

    const parentView = await tracker(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(parentView.status).toBe(0);
    expect(JSON.parse(parentView.stdout)).toMatchObject({
      identifier: "ENG-1",
      parent: null,
      children: [{ identifier: "ENG-2", title: "Add child issue" }]
    });

    const cleared = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-2",
      "--parent",
      "none",
      "--json"
    ]);
    expect(cleared.status).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      identifier: "ENG-2",
      parentId: null,
      parent: null
    });
  });

  it("adds and removes blockedBy/blocks dependencies through CLI flags", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Design"])).status).toBe(0);

    const build = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Build",
      "--blocked-by",
      "ENG-1",
      "--json"
    ]);
    expect(build.status).toBe(0);
    expect(JSON.parse(build.stdout)).toMatchObject({
      identifier: "ENG-2",
      blockedBy: [{ identifier: "ENG-1", title: "Design" }],
      blocks: []
    });

    const designView = await tracker(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(JSON.parse(designView.stdout)).toMatchObject({
      identifier: "ENG-1",
      blocks: [{ identifier: "ENG-2", title: "Build" }],
      blockedBy: []
    });

    const cleared = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-1",
      "--remove-blocks",
      "ENG-2",
      "--json"
    ]);
    expect(cleared.status).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({ identifier: "ENG-1", blocks: [] });
    const buildAfter = await tracker(dbPath, ["issue", "view", "ENG-2", "--json"]);
    expect(JSON.parse(buildAfter.stdout)).toMatchObject({ identifier: "ENG-2", blockedBy: [] });

    const cycle = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-1",
      "--blocked-by",
      "ENG-1",
      "--json"
    ]);
    expect(cycle.status).toBe(1);
    expect(JSON.parse(cycle.stderr)).toMatchObject({
      error: { code: "ISSUE_DEPENDENCY_CYCLE" }
    });
  });

  it("adds comments and threaded replies through the CLI and renders authors in issue view", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Review agent notes"])).status).toBe(
      0
    );

    const rootResult = await tracker(dbPath, [
      "issue",
      "comment",
      "ENG-1",
      "Initial investigation complete.",
      "--json"
    ]);
    expect(rootResult.status).toBe(0);
    const root = JSON.parse(rootResult.stdout) as Record<string, unknown>;
    expect(root).toMatchObject({
      body: "Initial investigation complete.",
      parentId: null,
      author: { handle: "owner" }
    });

    const replyResult = await tracker(dbPath, [
      "issue",
      "comment",
      "ENG-1",
      "Follow-up captured in the same thread.",
      "--parent",
      String(root.id),
      "--json"
    ]);
    expect(replyResult.status).toBe(0);
    const reply = JSON.parse(replyResult.stdout) as Record<string, unknown>;
    expect(reply).toMatchObject({
      body: "Follow-up captured in the same thread.",
      parentId: root.id,
      author: { handle: "owner" }
    });

    const viewJson = await tracker(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(viewJson.status).toBe(0);
    expect(
      (JSON.parse(viewJson.stdout) as {
        comments: Array<{ body: string; parentId: string | null; author: { handle: string } }>;
      }).comments.map((comment) => ({
        body: comment.body,
        parentId: comment.parentId,
        authorHandle: comment.author.handle
      }))
    ).toEqual([
      {
        body: "Initial investigation complete.",
        parentId: null,
        authorHandle: "owner"
      },
      {
        body: "Follow-up captured in the same thread.",
        parentId: root.id,
        authorHandle: "owner"
      }
    ]);

    const viewText = await tracker(dbPath, ["issue", "view", "ENG-1"]);
    expect(viewText.status).toBe(0);
    expect(stripAnsi(viewText.stdout)).toContain(
      "Comments\n  @owner  Initial investigation complete.\n    @owner  Follow-up captured in the same thread."
    );
  });

  it("adds issue attachments through CLI link variants and renders them in issue view", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Trace linked work"])).status).toBe(
      0
    );

    const genericLink = await tracker(dbPath, [
      "issue",
      "link",
      "ENG-1",
      "https://example.invalid/design-note",
      "--json"
    ]);
    expect(genericLink.status).toBe(0);
    expect(JSON.parse(genericLink.stdout)).toMatchObject({
      kind: "link",
      title: "https://example.invalid/design-note",
      url: "https://example.invalid/design-note",
      repoPath: null
    });

    const branch = await tracker(dbPath, [
      "issue",
      "link",
      "ENG-1",
      "--kind",
      "branch",
      "--repo",
      "/workspace/fictional-app",
      "--branch",
      "lf-73-attachments",
      "--json"
    ]);
    expect(branch.status).toBe(0);
    expect(JSON.parse(branch.stdout)).toMatchObject({
      kind: "branch",
      title: "lf-73-attachments",
      repoPath: "/workspace/fictional-app",
      branchName: "lf-73-attachments",
      url: null
    });

    const pr = await tracker(dbPath, [
      "issue",
      "link",
      "ENG-1",
      "--kind",
      "pr",
      "--repo",
      "/workspace/fictional-app",
      "--url",
      "https://example.invalid/fictional-app/pull/73",
      "--json"
    ]);
    expect(pr.status).toBe(0);
    expect(JSON.parse(pr.stdout)).toMatchObject({
      kind: "pr",
      repoPath: "/workspace/fictional-app",
      url: "https://example.invalid/fictional-app/pull/73"
    });

    const commit = await tracker(dbPath, [
      "issue",
      "link",
      "ENG-1",
      "--kind",
      "commit",
      "--repo",
      "/workspace/fictional-app",
      "--sha",
      "abc123def456",
      "--json"
    ]);
    expect(commit.status).toBe(0);
    expect(JSON.parse(commit.stdout)).toMatchObject({
      kind: "commit",
      repoPath: "/workspace/fictional-app",
      commitSha: "abc123def456"
    });

    const viewJson = await tracker(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(viewJson.status).toBe(0);
    const attachments = (JSON.parse(viewJson.stdout) as {
      attachments: Array<{
        kind: string;
        repoPath: string | null;
        branchName: string | null;
        commitSha: string | null;
      }>;
    }).attachments;
    expect(attachments.map((attachment) => attachment.kind)).toEqual([
      "link",
      "branch",
      "pr",
      "commit"
    ]);
    expect(attachments.map((attachment) => attachment.repoPath)).toEqual([
      null,
      "/workspace/fictional-app",
      "/workspace/fictional-app",
      "/workspace/fictional-app"
    ]);

    const viewText = await tracker(dbPath, ["issue", "view", "ENG-1"]);
    expect(viewText.status).toBe(0);
    const stripped = stripAnsi(viewText.stdout);
    expect(stripped).toContain("Attachments");
    expect(stripped).toContain("branch  lf-73-attachments  /workspace/fictional-app");
    expect(stripped).toContain("commit  abc123def456  /workspace/fictional-app");

    const missingBranch = await tracker(dbPath, [
      "issue",
      "link",
      "ENG-1",
      "--kind",
      "branch",
      "--repo",
      "/workspace/fictional-app",
      "--json"
    ]);
    expect(missingBranch.status).not.toBe(0);
    expect(JSON.parse(missingBranch.stderr)).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Input validation failed."
      }
    });
  });

  it("prints ordered issue history as JSON and text", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Track history"])).status).toBe(
      0
    );
    expect((await tracker(dbPath, ["issue", "move", "ENG-1", "In Progress"])).status).toBe(0);
    expect(
      (await tracker(dbPath, ["issue", "comment", "ENG-1", "History covered."])).status
    ).toBe(0);

    const historyJson = await tracker(dbPath, ["issue", "history", "ENG-1", "--json"]);
    expect(historyJson.status).toBe(0);

    const history = JSON.parse(historyJson.stdout) as Array<{
      action: string;
      actor: { handle: string };
      createdAt: string;
      data: Record<string, unknown>;
    }>;
    expect(history.map((entry) => entry.action)).toEqual([
      "created",
      "state_changed",
      "commented"
    ]);
    expect(history).toMatchObject([
      {
        actor: { handle: "owner" },
        createdAt: expect.any(String),
        data: { identifier: "ENG-1" }
      },
      { actor: { handle: "owner" }, data: { fromName: "Todo", toName: "In Progress" } },
      { actor: { handle: "owner" }, data: { parentId: null } }
    ]);

    const historyText = await tracker(dbPath, ["issue", "history", "ENG-1"]);
    expect(historyText.status).toBe(0);
    const stripped = stripAnsi(historyText.stdout);
    expect(stripped).toContain("@owner  created  ENG-1");
    expect(stripped).toContain("@owner  state_changed  Todo -> In Progress");
    expect(stripped).toContain("@owner  commented  comment=");
  });

  it("prints watch events since a cursor as JSONL and exits in one-shot mode", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Seed watch cursor"])).status).toBe(
      0
    );

    const initialWatch = await tracker(dbPath, ["watch", "--since", "0", "--once", "--json"]);
    expect(initialWatch.status).toBe(0);
    const initialEvents = parseJsonLines<{
      cursor: string;
      issueIdentifier: string;
      action: string;
      data: Record<string, unknown>;
    }>(initialWatch.stdout);

    expect(initialEvents.map((event) => [event.issueIdentifier, event.action])).toEqual([
      ["ENG-1", "created"]
    ]);
    expect(initialEvents[0]?.data).toMatchObject({ identifier: "ENG-1" });

    const cursor = initialEvents[0]?.cursor;
    expect(cursor).toEqual(expect.any(String));

    expect((await tracker(dbPath, ["issue", "create", "--title", "Emit new watch event"])).status).toBe(
      0
    );
    expect((await tracker(dbPath, ["issue", "move", "ENG-2", "In Progress"])).status).toBe(0);

    const nextWatch = await tracker(dbPath, [
      "watch",
      "--since",
      String(cursor),
      "--once",
      "--json"
    ]);
    expect(nextWatch.status).toBe(0);
    const nextEvents = parseJsonLines<{ cursor: string; issueIdentifier: string; action: string }>(
      nextWatch.stdout
    );

    expect(nextEvents.map((event) => [event.issueIdentifier, event.action])).toEqual([
      ["ENG-2", "created"],
      ["ENG-2", "state_changed"]
    ]);
    expect(Number(nextEvents[0]?.cursor)).toBeGreaterThan(Number(cursor));
    expect(Number(nextEvents[1]?.cursor)).toBeGreaterThan(Number(nextEvents[0]?.cursor));

    const emptyWatch = await tracker(dbPath, [
      "watch",
      "--since",
      String(nextEvents.at(-1)?.cursor),
      "--once",
      "--json"
    ]);
    expect(emptyWatch.status).toBe(0);
    expect(emptyWatch.stdout).toBe("");
  });

  it("resolves watch --since independently from --once", () => {
    expect(resolveWatchOptions({ since: "42" })).toEqual({
      intervalMs: 1000,
      once: false
    });
    expect(resolveWatchOptions({ once: true })).toEqual({
      intervalMs: 1000,
      once: true
    });
    expect(resolveWatchOptions({ since: "42", once: true, interval: 25 })).toEqual({
      intervalMs: 25,
      once: true
    });
  });

  it("creates, lists, archives, and applies labels through JSON commands", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const createdLabel = await tracker(dbPath, [
      "label",
      "create",
      "Bug",
      "--color",
      "#EF4444",
      "--json"
    ]);
    expect(createdLabel.status).toBe(0);
    expect(JSON.parse(createdLabel.stdout)).toMatchObject({
      name: "Bug",
      color: "#EF4444",
      group: null,
      archivedAt: null
    });

    expect((await tracker(dbPath, ["label", "create", "Docs", "--color", "#22C55E"])).status).toBe(
      0
    );
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Fix login redirect",
          "--label",
          "Bug"
        ])
      ).status
    ).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Refresh setup guide"])).status).toBe(
      0
    );

    const filtered = await tracker(dbPath, ["issue", "list", "--label", "Bug", "--json"]);
    expect(filtered.status).toBe(0);
    expect((JSON.parse(filtered.stdout) as Array<Record<string, unknown>>).map((issue) => issue.identifier)).toEqual([
      "ENG-1"
    ]);

    const updated = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-1",
      "--label",
      "Docs",
      "--remove-label",
      "Bug",
      "--json"
    ]);
    expect(updated.status).toBe(0);
    expect((JSON.parse(updated.stdout) as { labels: Array<{ name: string }> }).labels.map((label) => label.name)).toEqual([
      "Docs"
    ]);

    const view = await tracker(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(view.status).toBe(0);
    expect((JSON.parse(view.stdout) as { labels: Array<{ name: string }> }).labels.map((label) => label.name)).toEqual([
      "Docs"
    ]);

    const archived = await tracker(dbPath, ["label", "archive", "Bug", "--json"]);
    expect(archived.status).toBe(0);
    expect((JSON.parse(archived.stdout) as Record<string, unknown>).archivedAt).toEqual(
      expect.any(String)
    );

    const visibleLabels = await tracker(dbPath, ["label", "list", "--json"]);
    expect(visibleLabels.status).toBe(0);
    expect(
      (JSON.parse(visibleLabels.stdout) as Array<Record<string, unknown>>).map((label) => label.name)
    ).toEqual(["Docs"]);

    const allLabels = await tracker(dbPath, ["label", "list", "--include-archived", "--json"]);
    expect(allLabels.status).toBe(0);
    expect(
      (JSON.parse(allLabels.stdout) as Array<Record<string, unknown>>).map((label) => label.name)
    ).toEqual(["Bug", "Docs"]);

    const restored = await tracker(dbPath, ["label", "unarchive", "Bug", "--json"]);
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      name: "Bug",
      archivedAt: null
    });

    const restoredLabels = await tracker(dbPath, ["label", "list", "--json"]);
    expect(restoredLabels.status).toBe(0);
    expect(
      (JSON.parse(restoredLabels.stdout) as Array<Record<string, unknown>>).map(
        (label) => label.name
      )
    ).toEqual(["Bug", "Docs"]);
  });

  it("creates cycles, assigns issues to them, filters by cycle, and rejects duplicates", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const firstCycle = await tracker(dbPath, [
      "cycle",
      "create",
      "Cycle 1",
      "--starts-at",
      "2026-04-01T00:00:00.000Z",
      "--ends-at",
      "2026-04-15T00:00:00.000Z",
      "--json"
    ]);
    expect(firstCycle.status).toBe(0);
    const first = JSON.parse(firstCycle.stdout) as Record<string, unknown>;
    expect(first).toMatchObject({
      number: 1,
      name: "Cycle 1",
      startsAt: "2026-04-01T00:00:00.000Z",
      endsAt: "2026-04-15T00:00:00.000Z"
    });

    const secondCycle = await tracker(dbPath, [
      "cycle",
      "create",
      "--number",
      "2",
      "--name",
      "Cycle 2",
      "--json"
    ]);
    expect(secondCycle.status).toBe(0);
    const second = JSON.parse(secondCycle.stdout) as Record<string, unknown>;
    expect(second).toMatchObject({ number: 2, name: "Cycle 2" });

    const duplicate = await tracker(dbPath, [
      "cycle",
      "create",
      "Duplicate Cycle",
      "--number",
      "1",
      "--json"
    ]);
    expect(duplicate.status).not.toBe(0);
    expect(JSON.parse(duplicate.stderr)).toMatchObject({
      error: { code: "CONSTRAINT_VIOLATION" }
    });

    const created = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Fix cycle assignment",
      "--cycle",
      "1",
      "--json"
    ]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      identifier: "ENG-1",
      cycleId: first.id
    });

    expect((await tracker(dbPath, ["issue", "create", "--title", "Plan next cycle"])).status).toBe(0);

    const updated = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-2",
      "--cycle",
      String(second.id),
      "--json"
    ]);
    expect(updated.status).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      identifier: "ENG-2",
      cycleId: second.id
    });

    const filteredByNumber = await tracker(dbPath, ["issue", "list", "--cycle", "1", "--json"]);
    expect(filteredByNumber.status).toBe(0);
    expect(
      (JSON.parse(filteredByNumber.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-1"]);

    const filteredById = await tracker(dbPath, [
      "issue",
      "list",
      "--cycle",
      String(second.id),
      "--json"
    ]);
    expect(filteredById.status).toBe(0);
    expect(
      (JSON.parse(filteredById.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-2"]);

    const cycles = await tracker(dbPath, ["cycle", "list", "--json"]);
    expect(cycles.status).toBe(0);
    expect((JSON.parse(cycles.stdout) as Array<{ number: number }>).map((cycle) => cycle.number)).toEqual([
      1,
      2
    ]);
  });

  it("rejects out-of-range priority values", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const result = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Reject invalid priority",
      "--priority",
      "99",
      "--json"
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Input validation failed."
      }
    });
  });

  it("rejects invalid issue and project date values", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Validate dates"])).status).toBe(
      0
    );
    expect((await tracker(dbPath, ["project", "create", "Launch"])).status).toBe(0);

    const issueResult = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-1",
      "--due-date",
      "not-a-date",
      "--json"
    ]);
    expect(issueResult.status).not.toBe(0);
    expect(issueResult.stdout).toBe("");
    expect(JSON.parse(issueResult.stderr)).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });

    const projectResult = await tracker(dbPath, [
      "project",
      "update",
      "Launch",
      "--start-date",
      "2026-02-30",
      "--json"
    ]);
    expect(projectResult.status).not.toBe(0);
    expect(projectResult.stdout).toBe("");
    expect(JSON.parse(projectResult.stderr)).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
  });

  it("prints an error envelope to stderr with non-zero exit for a bad identifier", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const result = await tracker(dbPath, ["issue", "view", "ENG-404", "--json"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "ISSUE_NOT_FOUND",
        message: "Issue ENG-404 was not found.",
        details: { identifier: "ENG-404" }
      }
    });
  });
});

function tempDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-cli-"));
  tempDirs.push(tempDir);
  return join(tempDir, "tracker.db");
}

function buildCliPackage(): void {
  execFileSync("npm", ["run", "build", "-w", "@issue-tracker/cli"], {
    cwd: repoRoot,
    stdio: "pipe"
  });
}

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);

  return value
    .split(escape)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-?]*[ -/]*[@-~]/, "")))
    .join("");
}

function parseJsonLines<T>(value: string): T[] {
  return value
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function tracker(dbPath: string, args: string[]) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";

  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await run(["node", "tracker", "--db", dbPath, ...args]);
    return {
      status: typeof process.exitCode === "number" ? process.exitCode : 0,
      stdout,
      stderr
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
}
