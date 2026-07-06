import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createIssue,
  createLabel,
  createProject,
  init,
  openDb,
  whoami,
  type Clock,
  type ServiceContext
} from "@issue-tracker/core";

import { listIssuesData } from "../src/data/queries";
import { seedFilteredIssueListDb } from "./issue-list-fixture";

const tempDirs: string[] = [];
const originalIssueTrackerDb = process.env.ISSUE_TRACKER_DB;

afterEach(() => {
  if (originalIssueTrackerDb === undefined) {
    delete process.env.ISSUE_TRACKER_DB;
  } else {
    process.env.ISSUE_TRACKER_DB = originalIssueTrackerDb;
  }

  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("web data layer", () => {
  it("reads serialized issues from core using ISSUE_TRACKER_DB", async () => {
    const dbPath = seedIssueTrackerDb();
    process.env.ISSUE_TRACKER_DB = dbPath;

    const issues = await listIssuesData();

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      identifier: "ENG-1",
      title: "Render list view",
      description: null,
      priority: 2,
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      labels: [
        {
          name: "Frontend",
          color: "#14B8A6",
          group: "Area",
          archivedAt: null
        }
      ]
    });
  });

  it("passes list filters through to core individually and combined", async () => {
    const seeded = seedFilteredIssueListDb(tempDirs);
    process.env.ISSUE_TRACKER_DB = seeded.dbPath;

    await expectIdentifiers({ state: "In Progress" }, [
      "ENG-1",
      "ENG-3",
      "ENG-4",
      "ENG-5",
      "ENG-6",
      "ENG-7"
    ]);
    await expectIdentifiers({ assignee: "build-agent" }, [
      "ENG-1",
      "ENG-2",
      "ENG-4",
      "ENG-5",
      "ENG-6",
      "ENG-7"
    ]);
    await expectIdentifiers({ project: seeded.projectId }, [
      "ENG-1",
      "ENG-2",
      "ENG-3",
      "ENG-5",
      "ENG-6",
      "ENG-7"
    ]);
    await expectIdentifiers({ label: "Frontend" }, [
      "ENG-1",
      "ENG-2",
      "ENG-3",
      "ENG-4",
      "ENG-6",
      "ENG-7"
    ]);
    await expectIdentifiers({ priority: 1 }, [
      "ENG-1",
      "ENG-2",
      "ENG-3",
      "ENG-4",
      "ENG-5",
      "ENG-7"
    ]);
    await expectIdentifiers({ cycle: seeded.cycleNumber }, [
      "ENG-1",
      "ENG-2",
      "ENG-3",
      "ENG-4",
      "ENG-5",
      "ENG-6"
    ]);
    await expectIdentifiers(
      {
        state: "In Progress",
        assignee: "build-agent",
        project: seeded.projectId,
        label: "Frontend",
        priority: 1,
        cycle: seeded.cycleNumber
      },
      ["ENG-1"]
    );
    await expectIdentifiers(
      {
        state: "In Progress",
        assignee: "build-agent",
        project: seeded.projectId,
        label: "Frontend",
        priority: 1,
        cycle: seeded.cycleNumber,
        includeArchived: true
      },
      ["ENG-1", "ENG-8"]
    );
  });
});

async function expectIdentifiers(
  filters: Parameters<typeof listIssuesData>[0],
  identifiers: string[]
) {
  const issues = await listIssuesData(filters);

  expect(issues.map((issue) => issue.identifier)).toEqual(identifiers);
}

function seedIssueTrackerDb(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-web-"));
  tempDirs.push(tempDir);

  const dbPath = join(tempDir, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);

  try {
    const context: ServiceContext = {
      db,
      actor: null,
      clock: fixedClock("2026-03-01T12:00:00.000Z")
    };
    init(context, {
      teamKey: "ENG",
      teamName: "Engineering",
      actorHandle: "owner",
      actorName: "Human Owner"
    });
    context.actor = whoami(context);

    const project = createProject(context, {
      name: "Web Foundations",
      status: "started"
    });
    createLabel(context, {
      name: "Frontend",
      color: "#14B8A6",
      group: "Area"
    });
    createIssue(context, {
      title: "Render list view",
      projectId: project.id,
      priority: 2,
      labels: ["Frontend"]
    });
  } finally {
    db.$client.close();
  }

  return dbPath;
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}
