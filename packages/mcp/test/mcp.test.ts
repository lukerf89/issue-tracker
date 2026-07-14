import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  archiveIssue,
  archiveLabel,
  createActor,
  createCycle,
  createIssue,
  createLabel,
  createProject,
  createSavedView,
  createTeam,
  createTemplate,
  getActor,
  init,
  listActors,
  moveIssue,
  openDb,
  whoami,
  type Clock,
  type ServiceContext
} from "@issue-tracker/core";
import { createServer } from "../src/index.js";

const tempDirs: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("MCP server", () => {
  it("round-trips create_issue then get_issue through an in-process SDK client", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "build-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Set up CI",
        priority: 2
      });

      expect(created).toMatchObject({
        identifier: "ENG-1",
        title: "Set up CI",
        priority: 2
      });

      const fetched = await callJsonTool(client, "get_issue", {
        identifier: "ENG-1"
      });

      expect(fetched).toEqual(created);
    } finally {
      await client.close();
    }
  });

  it("sets blockedBy/blocks dependencies through create_issue and update_issue", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "build-agent" });

    try {
      await callJsonTool(client, "create_issue", { title: "Design" });
      const build = await callJsonTool(client, "create_issue", {
        title: "Build",
        blockedBy: ["ENG-1"]
      });

      expect(build).toMatchObject({
        identifier: "ENG-2",
        blockedBy: [{ identifier: "ENG-1", title: "Design" }],
        blocks: []
      });

      const design = await callJsonTool(client, "get_issue", { identifier: "ENG-1" });
      expect(design).toMatchObject({
        blocks: [{ identifier: "ENG-2", title: "Build" }]
      });

      const unblocked = await callJsonTool(client, "update_issue", {
        identifier: "ENG-2",
        removeBlockedBy: ["ENG-1"]
      });
      expect(unblocked).toMatchObject({ identifier: "ENG-2", blockedBy: [] });
    } finally {
      await client.close();
    }
  });

  it("returns byte-identical get_issue JSON to CLI issue view --json", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "review-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Write parity test",
        description: "Compare MCP and CLI JSON",
        priority: 1
      });

      const fetched = await callJsonTool(client, "get_issue", {
        identifier: created.identifier
      });
      const cliOutput = tracker(dbPath, ["issue", "view", created.identifier, "--json"]);

      expect(`${JSON.stringify(fetched)}\n`).toBe(cliOutput);
    } finally {
      await client.close();
    }
  });

  it("archives issues through archive_issue and matches CLI issue archive --json", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "archive-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Retire duplicate task"
      });

      const beforeArchive = (await callJsonTool(client, "list_issues", {})) as unknown as Array<
        Record<string, unknown>
      >;
      expect(beforeArchive.map((issue) => issue.identifier)).toEqual([created.identifier]);

      const archived = await callJsonTool(client, "archive_issue", {
        identifier: created.identifier
      });

      expect(archived).toMatchObject({
        identifier: created.identifier,
        title: "Retire duplicate task",
        archivedAt: expect.any(String)
      });
      expect(archived.archivedAt).not.toBeNull();

      const defaultList = (await callJsonTool(client, "list_issues", {})) as unknown as Array<
        Record<string, unknown>
      >;
      expect(defaultList).toEqual([]);

      const includeArchived = (await callJsonTool(client, "list_issues", {
        includeArchived: true
      })) as unknown as Array<Record<string, unknown>>;
      expect(includeArchived.map((issue) => issue.identifier)).toEqual([created.identifier]);

      const fetched = await callJsonTool(client, "get_issue", {
        identifier: created.identifier
      });
      expect(fetched).toEqual(archived);

      const activity = (await callJsonTool(client, "list_activity", {
        issue: created.identifier
      })) as unknown as Array<{
        action: string;
        actor: { handle: string };
        data: Record<string, unknown>;
      }>;
      expect(activity.map((entry) => entry.action)).toEqual(["created", "archived"]);
      expect(activity.at(-1)).toMatchObject({
        action: "archived",
        actor: { handle: "archive-agent" },
        data: { identifier: created.identifier }
      });

      const cliOutput = tracker(dbPath, ["issue", "archive", created.identifier, "--json"]);
      expect(`${JSON.stringify(archived)}\n`).toBe(cliOutput);
    } finally {
      await client.close();
    }
  });

  it("unarchives issues through unarchive_issue and restores default list visibility", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "restore-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Restore archived task"
      });

      await callJsonTool(client, "archive_issue", {
        identifier: created.identifier
      });

      const archivedList = (await callJsonTool(client, "list_issues", {})) as unknown as Array<
        Record<string, unknown>
      >;
      expect(archivedList).toEqual([]);

      const unarchived = await callJsonTool(client, "unarchive_issue", {
        identifier: created.identifier
      });

      expect(unarchived).toMatchObject({
        identifier: created.identifier,
        title: "Restore archived task",
        archivedAt: null
      });

      const visibleAgain = (await callJsonTool(client, "list_issues", {})) as unknown as Array<
        Record<string, unknown>
      >;
      expect(visibleAgain.map((issue) => issue.identifier)).toEqual([created.identifier]);

      const fetched = await callJsonTool(client, "get_issue", {
        identifier: created.identifier
      });
      expect(fetched).toEqual(unarchived);

      const activity = (await callJsonTool(client, "list_activity", {
        issue: created.identifier
      })) as unknown as Array<{
        action: string;
        actor: { handle: string };
        data: Record<string, unknown>;
      }>;
      expect(activity.map((entry) => entry.action)).toEqual(["created", "archived", "unarchived"]);
      expect(activity.at(-1)).toMatchObject({
        action: "unarchived",
        actor: { handle: "restore-agent" },
        data: { identifier: created.identifier }
      });

      await callJsonTool(client, "archive_issue", {
        identifier: created.identifier
      });
      const cliUnarchived = JSON.parse(
        tracker(dbPath, ["issue", "unarchive", created.identifier, "--json"])
      ) as Record<string, unknown>;
      expect(cliUnarchived).toMatchObject({
        id: unarchived.id,
        identifier: unarchived.identifier,
        title: unarchived.title,
        archivedAt: null
      });
    } finally {
      await client.close();
    }
  });

  it("returns byte-identical list_activity JSON to CLI issue history --json", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "history-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Track MCP history"
      });
      await callJsonTool(client, "update_issue", {
        identifier: created.identifier,
        priority: 2
      });
      await callJsonTool(client, "move_issue", {
        identifier: created.identifier,
        state: "In Progress"
      });
      await callJsonTool(client, "comment_on_issue", {
        issue: created.identifier,
        body: "History is available."
      });

      const activity = (await callJsonTool(client, "list_activity", {
        issue: created.identifier
      })) as unknown as Array<{
        action: string;
        actor: { handle: string };
        data: Record<string, unknown>;
      }>;
      const cliOutput = tracker(dbPath, ["issue", "history", created.identifier, "--json"]);

      expect(activity.map((entry) => entry.action)).toEqual([
        "created",
        "updated",
        "state_changed",
        "commented"
      ]);
      expect(activity).toMatchObject([
        { actor: { handle: "history-agent" }, data: { identifier: created.identifier } },
        { actor: { handle: "history-agent" }, data: { changed: { priority: 2 } } },
        { actor: { handle: "history-agent" }, data: { fromName: "Todo", toName: "In Progress" } },
        { actor: { handle: "history-agent" }, data: { parentId: null } }
      ]);
      expect(`${JSON.stringify(activity)}\n`).toBe(cliOutput);
    } finally {
      await client.close();
    }
  });

  it("returns byte-identical list_issues JSON to CLI issue list --json for combined filters", async () => {
    const dbPath = initializedDbPath();
    createListFilterFixtures(dbPath);
    const client = await connectClient(dbPath, { handle: "list-agent" });

    try {
      const filter = {
        state: "In Progress",
        assignee: "build-agent",
        project: "Platform Foundations",
        cycle: 1,
        label: "Bug",
        priority: 1,
        team: "ENG",
        includeArchived: true
      };
      const listed = await callJsonTool(client, "list_issues", filter);
      const cliOutput = tracker(dbPath, [
        "issue",
        "list",
        "--state",
        filter.state,
        "--assignee",
        filter.assignee,
        "--project",
        filter.project,
        "--cycle",
        String(filter.cycle),
        "--label",
        filter.label,
        "--priority",
        String(filter.priority),
        "--team",
        filter.team,
        "--include-archived",
        "--json"
      ]);

      expect(
        (listed as unknown as Array<Record<string, unknown>>).map((issue) => issue.identifier)
      ).toEqual(["ENG-1", "ENG-2"]);
      expect(`${JSON.stringify(listed)}\n`).toBe(cliOutput);
    } finally {
      await client.close();
    }
  });

  it("manages actors, teams, labels, cycles, and projects through MCP with CLI-equivalent JSON", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "manage-agent" });

    try {
      await callJsonTool(client, "create_actor", {
        type: "agent",
        handle: "qa-agent",
        name: "QA Agent"
      });
      const actors = await callJsonTool(client, "list_actors", {});
      expect(`${JSON.stringify(actors)}\n`).toBe(tracker(dbPath, ["actor", "list", "--json"]));

      await callJsonTool(client, "create_team", {
        key: "OPS",
        name: "Operations"
      });
      let teams = await callJsonTool(client, "list_teams", {});
      expect(`${JSON.stringify(teams)}\n`).toBe(tracker(dbPath, ["team", "list", "--json"]));

      await callJsonTool(client, "archive_team", { team: "OPS" });
      teams = await callJsonTool(client, "list_teams", {});
      expect((teams as unknown as Array<{ key: string }>).map((team) => team.key)).toEqual(["ENG"]);
      teams = await callJsonTool(client, "list_teams", { includeArchived: true });
      expect(`${JSON.stringify(teams)}\n`).toBe(
        tracker(dbPath, ["team", "list", "--include-archived", "--json"])
      );

      await callJsonTool(client, "unarchive_team", { team: "OPS" });
      teams = await callJsonTool(client, "list_teams", {});
      expect((teams as unknown as Array<{ key: string }>).map((team) => team.key)).toEqual([
        "ENG",
        "OPS"
      ]);

      await callJsonTool(client, "create_label", {
        name: "Bug",
        color: "#EF4444"
      });
      let labels = await callJsonTool(client, "list_labels", {});
      expect(`${JSON.stringify(labels)}\n`).toBe(tracker(dbPath, ["label", "list", "--json"]));

      await callJsonTool(client, "archive_label", { label: "Bug" });
      labels = await callJsonTool(client, "list_labels", {});
      expect(labels).toEqual([]);
      labels = await callJsonTool(client, "list_labels", { includeArchived: true });
      expect(`${JSON.stringify(labels)}\n`).toBe(
        tracker(dbPath, ["label", "list", "--include-archived", "--json"])
      );

      await callJsonTool(client, "unarchive_label", { label: "Bug" });
      labels = await callJsonTool(client, "list_labels", {});
      expect((labels as unknown as Array<{ name: string }>).map((label) => label.name)).toEqual([
        "Bug"
      ]);

      await callJsonTool(client, "create_cycle", {
        team: "OPS",
        name: "Cycle 1",
        startsAt: "2026-04-01T00:00:00.000Z",
        endsAt: "2026-04-15T00:00:00.000Z"
      });
      const cycles = await callJsonTool(client, "list_cycles", { team: "OPS" });
      expect(`${JSON.stringify(cycles)}\n`).toBe(
        tracker(dbPath, ["cycle", "list", "--team", "OPS", "--json"])
      );

      await callJsonTool(client, "create_project", {
        name: "Launch",
        status: "planned",
        startDate: "2026-08-01"
      });
      const updatedProject = await callJsonTool(client, "update_project", {
        project: "Launch",
        status: "started",
        targetDate: "2026-08-31"
      });
      expect(updatedProject).toMatchObject({
        name: "Launch",
        status: "started",
        startDate: "2026-08-01",
        targetDate: "2026-08-31"
      });

      await callJsonTool(client, "archive_project", { project: "Launch" });
      let projects = await callJsonTool(client, "list_projects", {});
      expect(projects).toEqual([]);
      projects = await callJsonTool(client, "list_projects", { includeArchived: true });
      expect(`${JSON.stringify(projects)}\n`).toBe(
        tracker(dbPath, ["project", "list", "--include-archived", "--json"])
      );

      await callJsonTool(client, "unarchive_project", { project: "Launch" });
      projects = await callJsonTool(client, "list_projects", {});
      expect((projects as unknown as Array<{ name: string }>).map((project) => project.name)).toEqual([
        "Launch"
      ]);
    } finally {
      await client.close();
    }
  });

  it("returns byte-identical list_saved_views JSON to CLI view list --json", async () => {
    const dbPath = initializedDbPath();
    const setup = openContext(dbPath);

    try {
      createSavedView(setup.context, {
        name: "Build bugs",
        filters: { label: "Bug", priority: 1 },
        description: null
      });
    } finally {
      setup.close();
    }

    const client = await connectClient(dbPath, { handle: "view-agent" });

    try {
      const views = (await callJsonTool(client, "list_saved_views", {})) as unknown as Array<{
        name: string;
        filters: Record<string, unknown>;
      }>;
      const cliOutput = tracker(dbPath, ["view", "list", "--json"]);

      expect(views).toMatchObject([
        {
          name: "Build bugs",
          filters: { label: "Bug", priority: 1 },
          description: null
        }
      ]);
      expect(`${JSON.stringify(views)}\n`).toBe(cliOutput);
    } finally {
      await client.close();
    }
  });

  it("creates, applies with overrides, and deletes saved views through MCP", async () => {
    const dbPath = initializedDbPath();
    const setup = openContext(dbPath);

    try {
      setup.context.actor = whoami(setup.context);
      createLabel(setup.context, { name: "Bug", color: "#EF4444" });
      createIssue(setup.context, {
        title: "Fix active bug",
        priority: 1,
        labels: ["Bug"]
      });
      createIssue(setup.context, {
        title: "Fix later bug",
        priority: 2,
        labels: ["Bug"]
      });
      createIssue(setup.context, {
        title: "Plan docs refresh",
        priority: 1
      });
    } finally {
      setup.close();
    }

    const client = await connectClient(dbPath, { handle: "view-agent" });

    try {
      const created = await callJsonTool(client, "create_saved_view", {
        name: "Priority bugs",
        filters: { label: "Bug", priority: 1 },
        description: "High-priority bug queue"
      });

      expect(created).toMatchObject({
        name: "Priority bugs",
        filters: { label: "Bug", priority: 1 },
        description: "High-priority bug queue"
      });

      const fromView = (await callJsonTool(client, "list_issues", {
        view: "Priority bugs"
      })) as unknown as Array<{ identifier: string }>;
      expect(fromView.map((issue) => issue.identifier)).toEqual(["ENG-1"]);

      const overridden = (await callJsonTool(client, "list_issues", {
        view: "Priority bugs",
        priority: 2
      })) as unknown as Array<{ identifier: string }>;
      expect(overridden.map((issue) => issue.identifier)).toEqual(["ENG-2"]);

      const deleted = await callJsonTool(client, "delete_saved_view", {
        idOrName: "Priority bugs"
      });
      expect(deleted).toMatchObject({
        name: "Priority bugs",
        filters: { label: "Bug", priority: 1 }
      });

      const afterDelete = await callJsonTool(client, "list_saved_views", {});
      expect(afterDelete).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("returns byte-identical list_templates JSON to CLI template list --json", async () => {
    const dbPath = initializedDbPath();
    const setup = openContext(dbPath);

    try {
      createTemplate(setup.context, {
        name: "Bug report",
        title: "Investigate fictional bug",
        description: "Capture reproduction steps.",
        priority: 2,
        team: "ENG",
        project: null,
        labels: ["Bug"]
      });
    } finally {
      setup.close();
    }

    const client = await connectClient(dbPath, { handle: "template-agent" });

    try {
      const templates = (await callJsonTool(client, "list_templates", {})) as unknown as Array<{
        name: string;
        labels: string[];
      }>;
      const cliOutput = tracker(dbPath, ["template", "list", "--json"]);

      expect(templates).toMatchObject([
        {
          name: "Bug report",
          title: "Investigate fictional bug",
          description: "Capture reproduction steps.",
          priority: 2,
          team: "ENG",
          project: null,
          labels: ["Bug"]
        }
      ]);
      expect(`${JSON.stringify(templates)}\n`).toBe(cliOutput);
    } finally {
      await client.close();
    }
  });

  it("creates, applies overrides, and deletes templates through MCP", async () => {
    const dbPath = initializedDbPath();
    const projectId = (() => {
      const setup = openContext(dbPath);

      try {
        createLabel(setup.context, { name: "Bug", color: "#EF4444" });
        return createProject(setup.context, {
          name: "Platform Foundations",
          status: "planned"
        }).id;
      } finally {
        setup.close();
      }
    })();

    const client = await connectClient(dbPath, { handle: "template-agent" });

    try {
      const created = await callJsonTool(client, "create_template", {
        name: "Bug report",
        title: "Investigate fictional bug",
        description: "Capture reproduction steps.",
        priority: 2,
        team: "ENG",
        project: "Platform Foundations",
        labels: ["Bug"]
      });
      expect(created).toMatchObject({
        name: "Bug report",
        title: "Investigate fictional bug",
        description: "Capture reproduction steps.",
        priority: 2,
        team: "ENG",
        project: projectId,
        labels: ["Bug"]
      });

      const issue = await callJsonTool(client, "create_issue_from_template", {
        name: "Bug report",
        overrides: {
          title: "Investigate export bug",
          priority: 1
        }
      });
      expect(issue).toMatchObject({
        identifier: "ENG-1",
        title: "Investigate export bug",
        description: "Capture reproduction steps.",
        priority: 1,
        projectId
      });
      expect((issue.labels as Array<{ name: string }>).map((label) => label.name)).toEqual([
        "Bug"
      ]);

      const deleted = await callJsonTool(client, "delete_template", {
        name: "Bug report"
      });
      expect(deleted).toMatchObject({
        name: "Bug report",
        project: projectId,
        labels: ["Bug"]
      });

      const afterDelete = await callJsonTool(client, "list_templates", {});
      expect(afterDelete).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("reads issue and backlog resources with byte-identical JSON to matching tools", async () => {
    const dbPath = initializedDbPath();
    const setup = openContext(dbPath);

    try {
      setup.context.actor = whoami(setup.context);
      createIssue(setup.context, {
        title: "Expose issue resource",
        priority: 1
      });
      createIssue(setup.context, {
        title: "Archived backlog item"
      });
      archiveIssue(setup.context, "ENG-2");
      createTeam(setup.context, { key: "OPS", name: "Operations" });
      createIssue(setup.context, {
        team: "OPS",
        title: "Separate operations issue"
      });
    } finally {
      setup.close();
    }

    const client = await connectClient(dbPath);

    try {
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(
        expect.arrayContaining(["issue://{identifier}", "backlog://{team}"])
      );

      const issueToolJson = await callJsonTool(client, "get_issue", { identifier: "ENG-1" });
      const issueResource = await client.readResource({ uri: "issue://ENG-1" });
      expect(jsonTextFromResource(issueResource, "issue://ENG-1")).toBe(
        JSON.stringify(issueToolJson)
      );

      const backlogToolJson = await callJsonTool(client, "list_issues", { team: "ENG" });
      const backlogResource = await client.readResource({ uri: "backlog://ENG" });
      const backlogJson = jsonTextFromResource(backlogResource, "backlog://ENG");
      expect(backlogJson).toBe(JSON.stringify(backlogToolJson));
      expect(
        (JSON.parse(backlogJson) as Array<{ identifier: string }>).map((issue) => issue.identifier)
      ).toEqual(["ENG-1"]);

      await expect(client.readResource({ uri: "issue://ENG-404" })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        data: {
          error: {
            code: "ISSUE_NOT_FOUND",
            message: "Issue ENG-404 was not found.",
            details: { identifier: "ENG-404" }
          }
        }
      });
    } finally {
      await client.close();
    }
  });

  it("returns byte-identical search JSON to CLI issue search --json", async () => {
    const dbPath = initializedDbPath();
    createSearchFixtures(dbPath);
    const client = await connectClient(dbPath, { handle: "search-agent" });

    try {
      const filter = { query: "login", team: "ENG", limit: 2 };
      const searched = (await callJsonTool(client, "search", filter)) as unknown as Array<
        Record<string, unknown>
      >;
      const cliOutput = tracker(dbPath, [
        "issue",
        "search",
        filter.query,
        "--team",
        filter.team,
        "--limit",
        String(filter.limit),
        "--json"
      ]);

      expect(searched.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2"]);
      expect(`${JSON.stringify(searched)}\n`).toBe(cliOutput);

      const all = (await callJsonTool(client, "search", {
        query: "LOGIN"
      })) as unknown as Array<Record<string, unknown>>;
      expect(all.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2", "OPS-1"]);
    } finally {
      await client.close();
    }
  });

  it("auto-creates unknown MCP agent handles but never auto-creates humans", async () => {
    const dbPath = initializedDbPath();
    const agentClient = await connectClient(dbPath, { handle: "triage-agent" });

    try {
      await callJsonTool(agentClient, "create_issue", {
        title: "File agent finding"
      });
    } finally {
      await agentClient.close();
    }

    const { context, close } = openContext(dbPath);
    try {
      expect(getActor(context, "triage-agent")).toMatchObject({
        type: "agent",
        handle: "triage-agent",
        name: "triage-agent"
      });
    } finally {
      close();
    }

    const humanClient = await connectClient(dbPath, {
      handle: "new-human",
      type: "human"
    });

    try {
      const result = await humanClient.callTool({
        name: "create_issue",
        arguments: { title: "Should not create human actor" }
      });

      expect(result.isError).toBe(true);
      expect(jsonFromToolResult(result)).toEqual({
        error: {
          code: "ACTOR_NOT_FOUND",
          message: "Actor new-human was not found.",
          details: { actor: "new-human" }
        }
      });
    } finally {
      await humanClient.close();
    }

    const after = openContext(dbPath);
    try {
      expect(listActors(after.context).map((actor) => actor.handle)).not.toContain("new-human");
    } finally {
      after.close();
    }
  });

  it("returns a structured actor error when mutations are invoked without an actor handle", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath);

    try {
      const result = await client.callTool({
        name: "create_issue",
        arguments: { title: "Missing actor handle" }
      });

      expect(result.isError).toBe(true);
      expect(jsonFromToolResult(result)).toEqual({
        error: {
          code: "ACTOR_NOT_FOUND",
          message: "MCP mutations require an agent actor handle."
        }
      });

      const archiveResult = await client.callTool({
        name: "archive_issue",
        arguments: { identifier: "ENG-1" }
      });

      expect(archiveResult.isError).toBe(true);
      expect(jsonFromToolResult(archiveResult)).toEqual({
        error: {
          code: "ACTOR_NOT_FOUND",
          message: "MCP mutations require an agent actor handle."
        }
      });

      const unarchiveResult = await client.callTool({
        name: "unarchive_issue",
        arguments: { identifier: "ENG-1" }
      });

      expect(unarchiveResult.isError).toBe(true);
      expect(jsonFromToolResult(unarchiveResult)).toEqual({
        error: {
          code: "ACTOR_NOT_FOUND",
          message: "MCP mutations require an agent actor handle."
        }
      });

      const linkResult = await client.callTool({
        name: "link_issue",
        arguments: {
          issue: "ENG-1",
          kind: "link",
          url: "https://example.invalid/no-actor-link"
        }
      });

      expect(linkResult.isError).toBe(true);
      expect(jsonFromToolResult(linkResult)).toEqual({
        error: {
          code: "ACTOR_NOT_FOUND",
          message: "MCP mutations require an agent actor handle."
        }
      });

      for (const [name, args] of [
        ["create_team", { key: "OPS", name: "Operations" }],
        ["create_saved_view", { name: "No actor view", filters: { state: "Todo" } }],
        ["delete_saved_view", { idOrName: "No actor view" }],
        ["create_template", { name: "No actor template", title: "No actor issue" }],
        ["delete_template", { name: "No actor template" }],
        ["create_issue_from_template", { name: "No actor template" }]
      ] as const) {
        const result = await client.callTool({
          name,
          arguments: args
        });

        expect(result.isError).toBe(true);
        expect(jsonFromToolResult(result)).toEqual({
          error: {
            code: "ACTOR_NOT_FOUND",
            message: "MCP mutations require an agent actor handle."
          }
        });
      }
    } finally {
      await client.close();
    }
  });

  it("lists actors and assigns, reassigns, and clears issues through assign_issue", async () => {
    const dbPath = initializedDbPath();
    const { issueIdentifier, buildAgentId } = createAssignmentFixtures(dbPath);

    const client = await connectClient(dbPath, { handle: "claim-agent" });

    try {
      const claimed = await callJsonTool(client, "assign_issue", {
        identifier: issueIdentifier,
        actor: "claim-agent"
      });
      const claimAgent = getPersistedActor(dbPath, "claim-agent");

      expect(claimed).toMatchObject({
        identifier: "ENG-1",
        assigneeId: claimAgent.id
      });
      expect(claimAgent).toMatchObject({
        type: "agent",
        handle: "claim-agent",
        name: "claim-agent"
      });

      const actors = (await callJsonTool(client, "list_actors", {})) as unknown as Array<{
        handle: string;
        type: string;
      }>;
      expect(actors.map((actor) => [actor.handle, actor.type])).toEqual([
        ["build-agent", "agent"],
        ["claim-agent", "agent"],
        ["owner", "human"]
      ]);

      const reassigned = await callJsonTool(client, "assign_issue", {
        identifier: issueIdentifier,
        actor: "build-agent"
      });
      expect(reassigned).toMatchObject({
        identifier: "ENG-1",
        assigneeId: buildAgentId
      });

      const filtered = (await callJsonTool(client, "list_issues", {
        assignee: "build-agent"
      })) as unknown as Array<Record<string, unknown>>;
      expect(filtered.map((issue) => issue.identifier)).toEqual(["ENG-1"]);

      const cleared = await callJsonTool(client, "assign_issue", {
        identifier: issueIdentifier,
        actor: null
      });
      expect(cleared).toMatchObject({
        identifier: "ENG-1",
        assigneeId: null
      });
    } finally {
      await client.close();
    }

    const humanClient = await connectClient(dbPath, {
      handle: "new-human",
      type: "human"
    });

    try {
      const result = await humanClient.callTool({
        name: "assign_issue",
        arguments: { identifier: issueIdentifier, actor: null }
      });

      expect(result.isError).toBe(true);
      expect(jsonFromToolResult(result)).toEqual({
        error: {
          code: "ACTOR_NOT_FOUND",
          message: "Actor new-human was not found.",
          details: { actor: "new-human" }
        }
      });
      expect(listPersistedActorHandles(dbPath)).not.toContain("new-human");
    } finally {
      await humanClient.close();
    }
  });

  it("returns structured validation errors from MCP tools", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "validation-agent" });

    try {
      const result = await client.callTool({
        name: "create_issue",
        arguments: { title: "Reject invalid priority", priority: 99 }
      });

      expect(result.isError).toBe(true);
      const envelope = jsonFromToolResult(result);
      expect(envelope).toMatchObject({
        error: {
          code: "VALIDATION_FAILED",
          message: "Input validation failed.",
          details: { issues: expect.any(Array) }
        }
      });
      expect(JSON.stringify(envelope)).toContain("priority");
    } finally {
      await client.close();
    }
  });

  it("lists labels and honors label fields on issue tools", async () => {
    const dbPath = initializedDbPath();
    const setup = openContext(dbPath);

    try {
      createLabel(setup.context, { name: "Bug", color: "#EF4444" });
      createLabel(setup.context, { name: "Docs", color: "#22C55E" });
      const archived = createLabel(setup.context, { name: "Archived", color: "#6B7280" });
      archiveLabel(setup.context, archived.id);
    } finally {
      setup.close();
    }

    const client = await connectClient(dbPath, { handle: "label-agent" });

    try {
      const labels = (await callJsonTool(client, "list_labels", {})) as unknown as Array<{
        name: string;
      }>;
      expect(labels.map((label) => label.name)).toEqual(["Bug", "Docs"]);

      const allLabels = (await callJsonTool(client, "list_labels", {
        includeArchived: true
      })) as unknown as Array<{ name: string }>;
      expect(allLabels.map((label) => label.name)).toEqual(["Archived", "Bug", "Docs"]);

      const created = await callJsonTool(client, "create_issue", {
        title: "Fix login redirect",
        labels: ["Bug"]
      });
      expect((created.labels as Array<{ name: string }>).map((label) => label.name)).toEqual([
        "Bug"
      ]);

      const updated = await callJsonTool(client, "update_issue", {
        identifier: created.identifier,
        labels: ["Docs"],
        removeLabels: ["Bug"]
      });
      expect((updated.labels as Array<{ name: string }>).map((label) => label.name)).toEqual([
        "Docs"
      ]);

      const filtered = (await callJsonTool(client, "list_issues", {
        label: "Docs"
      })) as unknown as Array<Record<string, unknown>>;
      expect(filtered.map((issue) => issue.identifier)).toEqual(["ENG-1"]);
    } finally {
      await client.close();
    }
  });

  it("lists cycles and honors cycle fields on issue tools", async () => {
    const dbPath = initializedDbPath();
    const { firstCycleId, secondCycleId } = createCycleFixtures(dbPath);

    const client = await connectClient(dbPath, { handle: "cycle-agent" });

    try {
      const cycles = (await callJsonTool(client, "list_cycles", {})) as unknown as Array<{
        number: number;
        name: string | null;
      }>;
      expect(cycles.map((cycle) => [cycle.number, cycle.name])).toEqual([
        [1, "Cycle 1"],
        [2, "Cycle 2"]
      ]);

      const created = await callJsonTool(client, "create_issue", {
        title: "Fix cycle assignment",
        cycle: 1
      });
      expect(created).toMatchObject({
        identifier: "ENG-1",
        cycleId: firstCycleId
      });

      const updated = await callJsonTool(client, "update_issue", {
        identifier: created.identifier,
        cycle: secondCycleId
      });
      expect(updated).toMatchObject({
        identifier: "ENG-1",
        cycleId: secondCycleId
      });

      const filtered = (await callJsonTool(client, "list_issues", {
        cycle: 2
      })) as unknown as Array<Record<string, unknown>>;
      expect(filtered.map((issue) => issue.identifier)).toEqual(["ENG-1"]);
    } finally {
      await client.close();
    }
  });

  it("honors parent fields on issue tools and returns relationship details", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "subissue-agent" });

    try {
      const firstParent = await callJsonTool(client, "create_issue", {
        title: "Build issue hierarchy"
      });
      const secondParent = await callJsonTool(client, "create_issue", {
        title: "Retarget issue hierarchy"
      });
      const child = await callJsonTool(client, "create_issue", {
        title: "Add child issue",
        parent: firstParent.identifier
      });

      expect(child).toMatchObject({
        identifier: "ENG-3",
        parentId: firstParent.id,
        parent: { identifier: "ENG-1" },
        children: []
      });

      const fetchedFirstParent = await callJsonTool(client, "get_issue", {
        identifier: firstParent.identifier
      });
      expect(fetchedFirstParent).toMatchObject({
        identifier: "ENG-1",
        parent: null,
        children: [{ identifier: "ENG-3", title: "Add child issue" }]
      });

      const updated = await callJsonTool(client, "update_issue", {
        identifier: child.identifier,
        parentId: secondParent.id
      });
      expect(updated).toMatchObject({
        identifier: "ENG-3",
        parentId: secondParent.id,
        parent: { identifier: "ENG-2" }
      });
    } finally {
      await client.close();
    }
  });

  it("adds comments and threaded replies through comment_on_issue", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "comment-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Review agent notes"
      });
      const root = await callJsonTool(client, "comment_on_issue", {
        issue: created.identifier,
        body: "Initial investigation complete."
      });
      expect(root).toMatchObject({
        issueId: created.id,
        body: "Initial investigation complete.",
        parentId: null,
        author: { handle: "comment-agent" }
      });

      const reply = await callJsonTool(client, "comment_on_issue", {
        issue: created.id,
        body: "Follow-up captured in the same thread.",
        parent: root.id
      });
      expect(reply).toMatchObject({
        issueId: created.id,
        body: "Follow-up captured in the same thread.",
        parentId: root.id,
        author: { handle: "comment-agent" }
      });

      const fetched = await callJsonTool(client, "get_issue", {
        identifier: created.identifier
      });
      expect(
        (
          fetched.comments as Array<{
            body: string;
            parentId: string | null;
            author: { handle: string };
          }>
        ).map((comment) => ({
          body: comment.body,
          parentId: comment.parentId,
          authorHandle: comment.author.handle
        }))
      ).toEqual([
        {
          body: "Initial investigation complete.",
          parentId: null,
          authorHandle: "comment-agent"
        },
        {
          body: "Follow-up captured in the same thread.",
          parentId: root.id,
          authorHandle: "comment-agent"
        }
      ]);
    } finally {
      await client.close();
    }
  });

  it("links issues to URLs, branches, PRs, and commits through link_issue", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "link-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Trace MCP linked work"
      });

      const link = await callJsonTool(client, "link_issue", {
        issue: created.identifier,
        kind: "link",
        url: "https://example.invalid/mcp-design-note"
      });
      expect(link).toMatchObject({
        issueId: created.id,
        kind: "link",
        title: "https://example.invalid/mcp-design-note",
        url: "https://example.invalid/mcp-design-note",
        repoPath: null
      });

      const branch = await callJsonTool(client, "link_issue", {
        issue: created.id,
        kind: "branch",
        repoPath: "/workspace/mcp-fictional-app",
        remote: "origin",
        branchName: "lf-73-mcp-attachments"
      });
      expect(branch).toMatchObject({
        issueId: created.id,
        kind: "branch",
        title: "lf-73-mcp-attachments",
        repoPath: "/workspace/mcp-fictional-app",
        remote: "origin",
        branchName: "lf-73-mcp-attachments",
        url: null,
        commitSha: null
      });

      const pr = await callJsonTool(client, "link_issue", {
        issue: created.identifier,
        kind: "pr",
        repoPath: "/workspace/mcp-fictional-app",
        url: "https://example.invalid/mcp-fictional-app/pull/73"
      });
      expect(pr).toMatchObject({
        kind: "pr",
        repoPath: "/workspace/mcp-fictional-app",
        url: "https://example.invalid/mcp-fictional-app/pull/73"
      });

      const commit = await callJsonTool(client, "link_issue", {
        issue: created.identifier,
        kind: "commit",
        repoPath: "/workspace/mcp-fictional-app",
        commitSha: "fed456abc123"
      });
      expect(commit).toMatchObject({
        kind: "commit",
        repoPath: "/workspace/mcp-fictional-app",
        commitSha: "fed456abc123"
      });

      const fetched = await callJsonTool(client, "get_issue", {
        identifier: created.identifier
      });
      expect(
        (
          fetched.attachments as Array<{
            id: string;
            kind: string;
            repoPath: string | null;
          }>
        ).map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          repoPath: attachment.repoPath
        }))
      ).toEqual([
        { id: link.id, kind: "link", repoPath: null },
        { id: branch.id, kind: "branch", repoPath: "/workspace/mcp-fictional-app" },
        { id: pr.id, kind: "pr", repoPath: "/workspace/mcp-fictional-app" },
        { id: commit.id, kind: "commit", repoPath: "/workspace/mcp-fictional-app" }
      ]);

      const activity = (await callJsonTool(client, "list_activity", {
        issue: created.identifier
      })) as unknown as Array<{
        action: string;
        actor: { handle: string };
        data: Record<string, unknown>;
      }>;
      expect(activity.map((entry) => entry.action)).toEqual([
        "created",
        "linked",
        "linked",
        "linked",
        "linked"
      ]);
      expect(activity.at(-1)).toMatchObject({
        action: "linked",
        actor: { handle: "link-agent" },
        data: {
          attachmentId: commit.id,
          kind: "commit",
          repoPath: "/workspace/mcp-fictional-app",
          commitSha: "fed456abc123"
        }
      });

      const cliOutput = tracker(dbPath, ["issue", "view", created.identifier, "--json"]);
      expect(`${JSON.stringify(fetched)}\n`).toBe(cliOutput);

      const missingCommitSha = await client.callTool({
        name: "link_issue",
        arguments: {
          issue: created.identifier,
          kind: "commit",
          repoPath: "/workspace/mcp-fictional-app"
        }
      });
      expect(missingCommitSha.isError).toBe(true);
      const envelope = jsonFromToolResult(missingCommitSha);
      expect(envelope).toMatchObject({
        error: {
          code: "VALIDATION_FAILED",
          message: "Input validation failed.",
          details: { issues: expect.any(Array) }
        }
      });
      expect(JSON.stringify(envelope)).toContain("commitSha");
    } finally {
      await client.close();
    }
  });
});

function createCycleFixtures(dbPath: string) {
  const setup = openContext(dbPath);

  try {
    const first = createCycle(setup.context, {
      team: "ENG",
      name: "Cycle 1",
      startsAt: "2026-04-01T00:00:00.000Z",
      endsAt: "2026-04-15T00:00:00.000Z"
    });
    const second = createCycle(setup.context, { team: "ENG", name: "Cycle 2" });

    return {
      firstCycleId: first.id,
      secondCycleId: second.id
    };
  } finally {
    setup.close();
  }
}

function createListFilterFixtures(dbPath: string): void {
  const setup = openContext(dbPath);

  try {
    setup.context.actor = whoami(setup.context);
    createActor(setup.context, {
      type: "agent",
      name: "Build Agent",
      handle: "build-agent"
    });
    createProject(setup.context, {
      name: "Platform Foundations",
      status: "planned"
    });
    createLabel(setup.context, { name: "Bug", color: "#EF4444" });
    createLabel(setup.context, { name: "Docs", color: "#22C55E" });
    createCycle(setup.context, { team: "ENG", name: "Cycle 1" });

    createIssue(setup.context, {
      title: "Active matching issue",
      assignee: "build-agent",
      project: "Platform Foundations",
      cycle: 1,
      priority: 1,
      labels: ["Bug"]
    });
    createIssue(setup.context, {
      title: "Archived matching issue",
      assignee: "build-agent",
      project: "Platform Foundations",
      cycle: 1,
      priority: 1,
      labels: ["Bug"]
    });
    createIssue(setup.context, {
      title: "Wrong priority",
      assignee: "build-agent",
      project: "Platform Foundations",
      cycle: 1,
      priority: 2,
      labels: ["Bug"]
    });
    createIssue(setup.context, {
      title: "Wrong label",
      assignee: "build-agent",
      project: "Platform Foundations",
      cycle: 1,
      priority: 1,
      labels: ["Docs"]
    });

    moveIssue(setup.context, "ENG-1", "In Progress");
    moveIssue(setup.context, "ENG-2", "In Progress");
    moveIssue(setup.context, "ENG-3", "In Progress");
    moveIssue(setup.context, "ENG-4", "In Progress");
    archiveIssue(setup.context, "ENG-2");
  } finally {
    setup.close();
  }
}

function createSearchFixtures(dbPath: string): void {
  const setup = openContext(dbPath);

  try {
    setup.context.actor = whoami(setup.context);
    createTeam(setup.context, { key: "OPS", name: "Operations" });
    createIssue(setup.context, {
      title: "Fix Login Redirect",
      description: "OAuth callback fails"
    });
    createIssue(setup.context, {
      title: "Refresh setup guide",
      description: "Mention login redirect setup"
    });
    createIssue(setup.context, {
      title: "Login operations runbook",
      team: "OPS"
    });
    createIssue(setup.context, {
      title: "Archived login cleanup"
    });
    archiveIssue(setup.context, "ENG-3");
  } finally {
    setup.close();
  }
}

function createAssignmentFixtures(dbPath: string) {
  const setup = openContext(dbPath);

  try {
    setup.context.actor = whoami(setup.context);
    const buildAgent = createActor(setup.context, {
      type: "agent",
      name: "Build Agent",
      handle: "build-agent"
    });
    const issue = createIssue(setup.context, { title: "Route MCP work" });

    return {
      issueIdentifier: issue.identifier,
      buildAgentId: buildAgent.id
    };
  } finally {
    setup.close();
  }
}

async function connectClient(
  dbPath: string,
  actor?: { handle: string; type?: "agent" | "human" }
) {
  const server = createServer({ dbPath, actor });
  const client = new Client({
    name: "issue-tracker-test",
    version: "0.0.0"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

async function callJsonTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name,
    arguments: args
  });
  const [content] = result.content;

  if (!content || content.type !== "text") {
    throw new Error(`Tool ${name} did not return JSON text content.`);
  }

  return JSON.parse(content.text) as Record<string, unknown>;
}

function jsonFromToolResult(result: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const [content] = result.content;

  if (!content || content.type !== "text" || typeof content.text !== "string") {
    throw new Error("Tool did not return JSON text content.");
  }

  return JSON.parse(content.text) as Record<string, unknown>;
}

function jsonTextFromResource(
  result: { contents: ReadonlyArray<{ uri: string; mimeType?: string; text?: string }> },
  uri: string
): string {
  const [content] = result.contents;

  if (!content || content.uri !== uri || content.mimeType !== "application/json") {
    throw new Error(`Resource ${uri} did not return application/json content.`);
  }

  if (typeof content.text !== "string") {
    throw new Error(`Resource ${uri} did not return JSON text content.`);
  }

  return content.text;
}

function initializedDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-mcp-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "tracker.db");
  const { context, close } = openContext(dbPath);

  try {
    init(context);
    context.actor = whoami(context);
  } finally {
    close();
  }

  return dbPath;
}

function getPersistedActor(dbPath: string, handle: string) {
  const { context, close } = openContext(dbPath);

  try {
    return getActor(context, handle);
  } finally {
    close();
  }
}

function listPersistedActorHandles(dbPath: string): string[] {
  const { context, close } = openContext(dbPath);

  try {
    return listActors(context).map((actor) => actor.handle);
  } finally {
    close();
  }
}

function openContext(dbPath: string) {
  const db = openDb(dbPath);
  applyMigrations(db);

  const context: ServiceContext = {
    db,
    actor: null,
    clock: fixedClock("2026-01-01T00:00:00.000Z")
  };

  return {
    context,
    close: () => db.$client.close()
  };
}

function tracker(dbPath: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "packages/cli/src/index.ts", "--db", dbPath, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8"
    }
  );
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}
