import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDb } from "../src/index.js";
import { activity, actors, attachments, issues, savedViews, teams, templates, workflowStates } from "../src/db/schema.js";

const tableNames = [
  "workspace",
  "config",
  "teams",
  "workflow_states",
  "projects",
  "milestones",
  "cycles",
  "issues",
  "labels",
  "issue_labels",
  "issue_dependencies",
  "repositories",
  "project_repositories",
  "issue_repositories",
  "orchestration_profiles",
  "agent_runs",
  "run_repositories",
  "run_attempts",
  "run_participants",
  "run_events",
  "run_artifacts",
  "run_input_requests",
  "run_verifications",
  "run_review_findings",
  "run_actions",
  "supervisor_instances",
  "issues_fts",
  "comments",
  "actors",
  "attachments",
  "activity",
  "saved_views",
  "templates"
] as const;

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("core database foundation", () => {
  it("applies migrations and creates every table with required constraints", () => {
    const db = openTempDb();

    try {
      applyMigrations(db);

      expect(listUserTables(db)).toEqual([...tableNames, "__drizzle_migrations"].sort());
      expect(foreignKeys(db, "issues")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "teams", from: "team_id", to: "id" }),
          expect.objectContaining({ table: "workflow_states", from: "state_id", to: "id" }),
          expect.objectContaining({ table: "projects", from: "project_id", to: "id" }),
          expect.objectContaining({ table: "cycles", from: "cycle_id", to: "id" }),
          expect.objectContaining({ table: "issues", from: "parent_id", to: "id" }),
          expect.objectContaining({ table: "actors", from: "assignee_id", to: "id" }),
          expect.objectContaining({ table: "actors", from: "creator_id", to: "id" })
        ])
      );
      expect(foreignKeys(db, "comments")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "issues", from: "issue_id", to: "id" }),
          expect.objectContaining({ table: "actors", from: "author_id", to: "id" })
        ])
      );
      expect(foreignKeys(db, "attachments")).toEqual([
        expect.objectContaining({ table: "issues", from: "issue_id", to: "id" })
      ]);
      expect(foreignKeys(db, "issue_labels")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "labels", from: "label_id", to: "id" }),
          expect.objectContaining({ table: "issues", from: "issue_id", to: "id" })
        ])
      );
      expect(foreignKeys(db, "issue_dependencies")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "issues", from: "blocking_issue_id", to: "id" }),
          expect.objectContaining({ table: "issues", from: "blocked_issue_id", to: "id" })
        ])
      );
      expect(uniqueColumnSets(db, "issue_dependencies")).toContainEqual([
        "blocking_issue_id",
        "blocked_issue_id"
      ]);
      expect(foreignKeys(db, "activity")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: "issues", from: "issue_id", to: "id" }),
          expect.objectContaining({ table: "actors", from: "actor_id", to: "id" })
        ])
      );
      expect(uniqueColumnSets(db, "teams")).toContainEqual(["key"]);
      expect(uniqueColumnSets(db, "actors")).toContainEqual(["handle"]);
      expect(uniqueColumnSets(db, "issues")).toEqual(
        expect.arrayContaining([
          ["identifier"],
          ["team_id", "number"]
        ])
      );
      expect(uniqueColumnSets(db, "workflow_states")).toContainEqual(["team_id", "name"]);
      expect(uniqueColumnSets(db, "cycles")).toContainEqual(["team_id", "number"]);
      expect(uniqueColumnSets(db, "labels")).toContainEqual(["name", "group_key"]);
      expect(uniqueColumnSets(db, "saved_views")).toContainEqual(["name"]);
      expect(uniqueColumnSets(db, "templates")).toContainEqual(["name"]);
    } finally {
      db.$client.close();
    }
  });

  it("enforces duplicate team keys, issue numbers, saved view names, and template names at the DB layer", () => {
    const db = openTempDb();

    try {
      applyMigrations(db);
      insertIssueFixture(db);
      insertSavedViewFixture(db);
      insertTemplateFixture(db);

      expect(() =>
        db.insert(teams).values({
          id: "team-duplicate",
          key: "ENG",
          name: "Engineering"
        }).run()
      ).toThrow();

      expect(() =>
        db.insert(issues).values({
          id: "issue-duplicate",
          identifier: "ENG-2",
          teamId: "team-eng",
          number: 1,
          title: "Duplicate number",
          stateId: "state-todo",
          creatorId: "actor-human",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }).run()
      ).toThrow();

      expect(() =>
        db.insert(savedViews).values({
          id: "saved-view-duplicate",
          name: "My active work",
          filters: { state: "Todo" },
          description: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }).run()
      ).toThrow();

      expect(() =>
        db.insert(templates).values({
          id: "template-duplicate",
          name: "Bug report",
          title: "Duplicate template",
          description: null,
          priority: null,
          team: null,
          project: null,
          labels: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }).run()
      ).toThrow();
    } finally {
      db.$client.close();
    }
  });

  it("backfills Blocked into teams created before the blocked-state migration", () => {
    const db = openTempDb();

    try {
      applyMigrations(db, { migrationsFolder: preBlockedMigrationsFolder() });
      insertPreBlockedTeamFixture(db);

      applyMigrations(db);

      const states = db.$client
        .prepare(
          "select name, type, position from workflow_states where team_id = ? order by position, name"
        )
        .all("team-eng");

      expect(states).toEqual([
        { name: "Backlog", type: "backlog", position: 0 },
        { name: "Todo", type: "unstarted", position: 1 },
        { name: "In Progress", type: "started", position: 2 },
        { name: "Blocked", type: "blocked", position: 3 },
        { name: "Done", type: "completed", position: 4 },
        { name: "Canceled", type: "canceled", position: 5 }
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("backfills the FTS index for issues that existed before the 0005 migration", () => {
    const db = openTempDb();

    try {
      // Migrate only through 0004 (before the FTS table/triggers exist), then
      // seed a pre-existing issue with no FTS row.
      applyMigrations(db, {
        migrationsFolder: partialMigrationsFolder([
          "0000_initial",
          "0001_nebulous_medusa",
          "0002_puzzling_red_skull",
          "0003_add_blocked_workflow_state",
          "0004_add_issue_dependencies"
        ])
      });
      insertIssueFixture(db);

      // Applying the remaining migrations creates the FTS table and backfills it.
      applyMigrations(db);

      const rows = db.$client
        .prepare(
          "select issue_id from issues_fts where issues_fts match ? order by rank"
        )
        .all('"set"* "up"*') as Array<{ issue_id: string }>;

      expect(rows.map((row) => row.issue_id)).toEqual(["issue-eng-1"]);
    } finally {
      db.$client.close();
    }
  });

  it("upgrades a populated pre-run database without changing issue history", () => {
    const db = openTempDb();
    try {
      applyMigrations(db, { migrationsFolder: partialMigrationsFolder(["0000_initial", "0001_nebulous_medusa", "0002_puzzling_red_skull", "0003_add_blocked_workflow_state", "0004_add_issue_dependencies", "0005_add_issue_fts"]) });
      insertIssueFixture(db);
      db.insert(attachments).values({ id: "attachment-before-runs", issueId: "issue-eng-1", kind: "link", title: "Fictional design", url: "https://example.test/design", repoPath: null, remote: null, branchName: null, commitSha: null, createdAt: "2026-01-01T00:01:00.000Z" }).run();
      db.insert(activity).values({ id: "activity-before-runs", issueId: "issue-eng-1", actorId: "actor-human", action: "linked", data: { title: "Fictional design" }, createdAt: "2026-01-01T00:01:00.000Z" }).run();

      applyMigrations(db);

      expect(db.query.issues.findFirst().sync()).toMatchObject({ id: "issue-eng-1", title: "Set up CI" });
      expect(db.query.attachments.findFirst().sync()).toMatchObject({ id: "attachment-before-runs", title: "Fictional design" });
      expect(db.query.activity.findFirst().sync()).toMatchObject({ id: "activity-before-runs", action: "linked", data: { title: "Fictional design" } });
    } finally { db.$client.close(); }
  });
});

function openTempDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-core-"));
  tempDirs.push(tempDir);

  return openDb(join(tempDir, "tracker.db"));
}

function insertIssueFixture(db: ReturnType<typeof openDb>): void {
  db.insert(teams)
    .values({
      id: "team-eng",
      key: "ENG",
      name: "Engineering"
    })
    .run();
  db.insert(actors)
    .values({
      id: "actor-human",
      type: "human",
      name: "Human Owner",
      handle: "owner"
    })
    .run();
  db.insert(workflowStates)
    .values({
      id: "state-todo",
      teamId: "team-eng",
      name: "Todo",
      type: "unstarted",
      color: "#6B7280",
      position: 1
    })
    .run();
  db.insert(issues)
    .values({
      id: "issue-eng-1",
      identifier: "ENG-1",
      teamId: "team-eng",
      number: 1,
      title: "Set up CI",
      stateId: "state-todo",
      creatorId: "actor-human",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })
    .run();
}

function insertPreBlockedTeamFixture(db: ReturnType<typeof openDb>): void {
  db.insert(teams)
    .values({
      id: "team-eng",
      key: "ENG",
      name: "Engineering"
    })
    .run();
  db.insert(workflowStates)
    .values([
      {
        id: "state-backlog",
        teamId: "team-eng",
        name: "Backlog",
        type: "backlog",
        color: "#9CA3AF",
        position: 0
      },
      {
        id: "state-todo",
        teamId: "team-eng",
        name: "Todo",
        type: "unstarted",
        color: "#6B7280",
        position: 1
      },
      {
        id: "state-in-progress",
        teamId: "team-eng",
        name: "In Progress",
        type: "started",
        color: "#2563EB",
        position: 2
      },
      {
        id: "state-done",
        teamId: "team-eng",
        name: "Done",
        type: "completed",
        color: "#16A34A",
        position: 3
      },
      {
        id: "state-canceled",
        teamId: "team-eng",
        name: "Canceled",
        type: "canceled",
        color: "#DC2626",
        position: 4
      }
    ])
    .run();
}

function insertSavedViewFixture(db: ReturnType<typeof openDb>): void {
  db.insert(savedViews)
    .values({
      id: "saved-view-active",
      name: "My active work",
      filters: { state: "Todo", priority: 1 },
      description: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })
    .run();
}

function insertTemplateFixture(db: ReturnType<typeof openDb>): void {
  db.insert(templates)
    .values({
      id: "template-bug-report",
      name: "Bug report",
      title: "Investigate fictional bug",
      description: "Capture reproduction steps.",
      priority: 2,
      team: "ENG",
      project: null,
      labels: ["Bug"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })
    .run();
}

function listUserTables(db: ReturnType<typeof openDb>): string[] {
  const rows = db.$client
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'issues_fts_%' order by name"
    )
    .all() as Array<{ name: string }>;

  return rows.map((row) => row.name).sort();
}

function foreignKeys(db: ReturnType<typeof openDb>, table: string) {
  return db.$client.prepare(`pragma foreign_key_list(${table})`).all();
}

function uniqueColumnSets(db: ReturnType<typeof openDb>, table: string): string[][] {
  const indexes = db.$client.prepare(`pragma index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
  }>;

  return indexes
    .filter((index) => index.unique === 1)
    .map((index) => {
      const columns = db.$client.prepare(`pragma index_info(${index.name})`).all() as Array<{
        seqno: number;
        name: string;
      }>;

      return columns.sort((a, b) => a.seqno - b.seqno).map((column) => column.name);
    });
}

function preBlockedMigrationsFolder(): string {
  return partialMigrationsFolder([
    "0000_initial",
    "0001_nebulous_medusa",
    "0002_puzzling_red_skull"
  ]);
}

function partialMigrationsFolder(tags: string[]): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-core-migrations-"));
  tempDirs.push(tempDir);

  const source = join(dirname(fileURLToPath(import.meta.url)), "../src/migrations");
  const target = join(tempDir, "migrations");
  const targetMeta = join(target, "meta");

  mkdirSync(targetMeta, { recursive: true });

  for (const tag of tags) {
    copyFileSync(join(source, `${tag}.sql`), join(target, `${tag}.sql`));
    copyFileSync(
      join(source, "meta", `${tag.split("_")[0]}_snapshot.json`),
      join(targetMeta, `${tag.split("_")[0]}_snapshot.json`)
    );
  }

  const journal = JSON.parse(readFileSync(join(source, "meta", "_journal.json"), "utf8")) as {
    version: string;
    dialect: string;
    entries: unknown[];
  };

  writeFileSync(
    join(targetMeta, "_journal.json"),
    `${JSON.stringify({ ...journal, entries: journal.entries.slice(0, tags.length) }, null, 2)}\n`
  );

  return target;
}
