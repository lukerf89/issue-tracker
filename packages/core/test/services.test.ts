import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createIssue,
  createProject,
  getIssue,
  init,
  listIssues,
  moveIssue,
  openDb,
  serializeIssue,
  updateIssue,
  whoami,
  type Clock,
  type Db,
  type ServiceContext
} from "../src/index.js";
import { teams } from "../src/db/schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("core services", () => {
  it("drives create -> list -> move -> get through core services", () => {
    const { context, close } = initializedContext();

    try {
      const project = createProject(context, {
        name: "Platform Foundations",
        status: "planned"
      });
      const issue = createIssue(context, {
        title: "Set up CI",
        projectId: project.id,
        priority: 2
      });

      expect(issue.identifier).toBe("ENG-1");
      expect(issue.projectId).toBe(project.id);
      expect(listIssues(context).map((listed) => listed.identifier)).toEqual(["ENG-1"]);
      expect(listIssues(context, { project: project.id })).toHaveLength(1);
      expect(listIssues(context, { state: "Todo" })).toHaveLength(1);

      context.clock = fixedClock("2026-01-01T00:10:00.000Z");
      const moved = moveIssue(context, "ENG-1", "In Progress");
      const fetched = getIssue(context, "ENG-1");

      expect(moved.stateId).toBe(fetched.stateId);
      expect(fetched.startedAt).toBe("2026-01-01T00:10:00.000Z");
    } finally {
      close();
    }
  });

  it("applies lifecycle timestamps with an injected clock", () => {
    const { context, close } = initializedContext("2026-02-01T00:00:00.000Z");

    try {
      createIssue(context, { title: "Implement lifecycle states" });

      context.clock = fixedClock("2026-02-01T01:00:00.000Z");
      const started = moveIssue(context, "ENG-1", "In Progress");
      expect(started.startedAt).toBe("2026-02-01T01:00:00.000Z");
      expect(started.completedAt).toBeNull();
      expect(started.canceledAt).toBeNull();

      context.clock = fixedClock("2026-02-01T02:00:00.000Z");
      const completed = moveIssue(context, "ENG-1", "Done");
      expect(completed.startedAt).toBe("2026-02-01T01:00:00.000Z");
      expect(completed.completedAt).toBe("2026-02-01T02:00:00.000Z");
      expect(completed.canceledAt).toBeNull();

      context.clock = fixedClock("2026-02-01T03:00:00.000Z");
      const canceled = moveIssue(context, "ENG-1", "Canceled");
      expect(canceled.completedAt).toBeNull();
      expect(canceled.canceledAt).toBe("2026-02-01T03:00:00.000Z");

      context.clock = fixedClock("2026-02-01T04:00:00.000Z");
      const reopenedToTodo = moveIssue(context, "ENG-1", "Todo");
      expect(reopenedToTodo.completedAt).toBeNull();
      expect(reopenedToTodo.canceledAt).toBeNull();
      expect(reopenedToTodo.startedAt).toBe("2026-02-01T01:00:00.000Z");

      context.clock = fixedClock("2026-02-01T05:00:00.000Z");
      const completedAgain = moveIssue(context, "ENG-1", "Done");
      expect(completedAgain.completedAt).toBe("2026-02-01T05:00:00.000Z");

      context.clock = fixedClock("2026-02-01T06:00:00.000Z");
      const reopenedToStarted = moveIssue(context, "ENG-1", "In Progress");
      expect(reopenedToStarted.completedAt).toBeNull();
      expect(reopenedToStarted.canceledAt).toBeNull();
      expect(reopenedToStarted.startedAt).toBe("2026-02-01T06:00:00.000Z");
    } finally {
      close();
    }
  });

  it("allocates distinct gapless issue numbers in the team transaction", () => {
    const { context, db, close } = initializedContext();

    try {
      const issues = [
        createIssue(context, { title: "Set up CI" }),
        createIssue(context, { title: "Add smoke tests" }),
        createIssue(context, { title: "Document commands" })
      ];

      expect(issues.map((issue) => issue.number)).toEqual([1, 2, 3]);
      expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
      expect(new Set(issues.map((issue) => issue.identifier)).size).toBe(3);

      const [team] = db.select().from(teams).where(eq(teams.key, "ENG")).all();
      expect(team?.issueCounter).toBe(3);
    } finally {
      close();
    }
  });

  it("writes exactly one activity row per issue mutation", () => {
    const { context, db, close } = initializedContext();

    try {
      createIssue(context, { title: "Track activity" });
      expect(readActivityActions(db)).toEqual(["created"]);

      updateIssue(context, "ENG-1", { title: "Track mutation activity" });
      expect(readActivityActions(db)).toEqual(["created", "updated"]);

      moveIssue(context, "ENG-1", "In Progress");
      expect(readActivityActions(db)).toEqual(["created", "updated", "state_changed"]);
    } finally {
      close();
    }
  });

  it("serializes issues with ISO timestamps, camelCase keys, and explicit nulls", () => {
    const { context, close } = initializedContext("2026-03-01T00:00:00.000Z");

    try {
      const issue = createIssue(context, { title: "Return JSON contract" });
      const serialized = serializeIssue(issue);

      expect(Object.keys(serialized)).toEqual([
        "id",
        "identifier",
        "teamId",
        "number",
        "title",
        "description",
        "stateId",
        "priority",
        "assigneeId",
        "creatorId",
        "projectId",
        "cycleId",
        "parentId",
        "estimate",
        "dueDate",
        "sortOrder",
        "createdAt",
        "updatedAt",
        "startedAt",
        "completedAt",
        "canceledAt",
        "archivedAt"
      ]);
      expect(serialized).toMatchObject({
        identifier: "ENG-1",
        description: null,
        assigneeId: null,
        projectId: null,
        cycleId: null,
        parentId: null,
        estimate: null,
        dueDate: null,
        startedAt: null,
        completedAt: null,
        canceledAt: null,
        archivedAt: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z"
      });
      expect(JSON.stringify(serialized)).not.toContain("undefined");
    } finally {
      close();
    }
  });
});

function initializedContext(now = "2026-01-01T00:00:00.000Z") {
  const db = openTempDb();
  applyMigrations(db);

  const context: ServiceContext = { db, actor: null, clock: fixedClock(now) };
  init(context);
  context.actor = whoami(context);

  return {
    context,
    db,
    close: () => db.$client.close()
  };
}

function openTempDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-services-"));
  tempDirs.push(tempDir);

  return openDb(join(tempDir, "tracker.db"));
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}

function readActivityActions(db: Db): string[] {
  const rows = db.$client
    .prepare("select action from activity order by rowid")
    .all() as Array<{ action: string }>;

  return rows.map((entry) => entry.action);
}
