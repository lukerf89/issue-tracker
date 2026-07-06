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

import { createIssueFormAction } from "../src/data/actions";
import { getIssueListPageData, listIssuesData } from "../src/data/queries";
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

  it("creates an issue through the form action and exposes it in the list data", async () => {
    const seeded = seedFilteredIssueListDb(tempDirs);
    process.env.ISSUE_TRACKER_DB = seeded.dbPath;
    const formData = new FormData();
    formData.set("title", "Create issue from web form");
    formData.set("description", "Created through the LF-85 create flow.");
    formData.set("team", "ENG");
    formData.set("project", seeded.projectId);
    formData.set("priority", "3");
    formData.set("assignee", "build-agent");
    formData.append("labels", "Frontend");

    const created = await createIssueFormAction(formData);
    const issues = await listIssuesData();
    const listed = issues.find((issue) => issue.identifier === created.identifier);

    expect(created).toMatchObject({
      title: "Create issue from web form",
      description: "Created through the LF-85 create flow.",
      priority: 3
    });
    expect(listed).toMatchObject({
      identifier: created.identifier,
      title: "Create issue from web form",
      description: "Created through the LF-85 create flow.",
      priority: 3,
      projectId: seeded.projectId
    });
    expect(listed?.labels.map((label) => label.name)).toEqual(["Frontend"]);
  });

  it("uses the list page q parameter for core-backed issue search", async () => {
    const seeded = seedFilteredIssueListDb(tempDirs);
    process.env.ISSUE_TRACKER_DB = seeded.dbPath;

    const data = await getIssueListPageData({ q: "Document" });

    expect(data.issues.map((issue) => issue.identifier)).toEqual(["ENG-4"]);
  });

  it("intersects list page search results with active filters and archived inclusion", async () => {
    const seeded = seedFilteredIssueListDb(tempDirs);
    process.env.ISSUE_TRACKER_DB = seeded.dbPath;

    await expectListPageIdentifiers({ q: "backlog", state: "In Progress" }, []);
    await expectListPageIdentifiers({ q: "frontend", assignee: "build-agent" }, []);
    await expectListPageIdentifiers({ q: "Archived", includeArchived: true }, ["ENG-8"]);
  });
});

async function expectIdentifiers(
  filters: Parameters<typeof listIssuesData>[0],
  identifiers: string[]
) {
  const issues = await listIssuesData(filters);

  expect(issues.map((issue) => issue.identifier)).toEqual(identifiers);
}

async function expectListPageIdentifiers(
  filters: Parameters<typeof getIssueListPageData>[0],
  identifiers: string[]
) {
  const data = await getIssueListPageData(filters);

  expect(data.issues.map((issue) => issue.identifier)).toEqual(identifiers);
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
