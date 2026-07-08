import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addAttachment,
  addComment,
  applyMigrations,
  createActor,
  createCycle,
  createIssue,
  createLabel,
  createProject,
  createSavedView,
  createTemplate,
  createTeam,
  exportSnapshot,
  getIssue,
  importSnapshot,
  init,
  listActivity,
  openDb,
  uuid,
  whoami,
  type Clock,
  type ServiceContext
} from "../src/index.js";
import { milestones } from "../src/db/schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("importSnapshot", () => {
  it("round-trips a full workspace snapshot into a fresh database", () => {
    const source = populatedContext();
    const destination = emptyContext();

    try {
      const snapshot = exportSnapshot(source.context);
      const child = snapshot.issues.find((issue) => issue.parentId !== null);
      const parentComment = snapshot.comments.find((comment) => comment.parentId === null);

      expect(child).toBeDefined();
      expect(parentComment).toBeDefined();

      const summary = importSnapshot(destination.context, snapshot);

      expect(summary).toEqual({
        workspace: 1,
        config: 2,
        teams: 2,
        workflowStates: 12,
        projects: 1,
        milestones: 1,
        cycles: 1,
        issues: 2,
        labels: 2,
        issueLabels: 2,
        comments: 2,
        actors: 2,
        attachments: 1,
        activity: snapshot.activity.length,
        savedViews: 1,
        templates: 1
      });
      expect(exportSnapshot(destination.context)).toEqual(snapshot);

      const importedChild = getIssue(destination.context, child?.identifier ?? "");
      expect(importedChild.parent?.id).toBe(child?.parentId);
      expect(importedChild.comments.map((comment) => [comment.body, comment.parentId])).toEqual([
        ["Snapshot includes parent comments.", null],
        ["Snapshot includes replies.", parentComment?.id]
      ]);
      expect(importedChild.attachments.map((attachment) => attachment.kind)).toEqual(["branch"]);
      expect(listActivity(destination.context, { issue: importedChild.identifier }).map((entry) => entry.id))
        .toEqual(snapshot.activity.filter((entry) => entry.issueId === importedChild.id).map((entry) => entry.id));
    } finally {
      source.close();
      destination.close();
    }
  });

  it("refuses non-empty databases unless forced, and force replaces existing rows", () => {
    const source = populatedContext();
    const destination = initializedContext("2026-05-02T00:00:00.000Z");

    try {
      const snapshot = exportSnapshot(source.context);
      const before = exportSnapshot(destination.context);

      expect(() => importSnapshot(destination.context, snapshot)).toThrow("empty database");
      expect(exportSnapshot(destination.context)).toEqual(before);

      const summary = importSnapshot(destination.context, snapshot, { force: true });

      expect(summary.issues).toBe(2);
      expect(exportSnapshot(destination.context)).toEqual(snapshot);
    } finally {
      source.close();
      destination.close();
    }
  });

  it("validates the snapshot shape before writing rows", () => {
    const destination = emptyContext();

    try {
      expect(() => importSnapshot(destination.context, { workspace: null })).toThrow();
      expect(exportSnapshot(destination.context)).toEqual({
        workspace: null,
        config: [],
        teams: [],
        workflowStates: [],
        projects: [],
        milestones: [],
        cycles: [],
        issues: [],
        labels: [],
        issueLabels: [],
        comments: [],
        actors: [],
        attachments: [],
        activity: [],
        savedViews: [],
        templates: []
      });
    } finally {
      destination.close();
    }
  });
});

function populatedContext() {
  const context = initializedContext("2026-05-01T00:00:00.000Z");
  const { db } = context;

  createTeam(context.context, { key: "OPS", name: "Operations" });
  const agent = createActor(context.context, {
    type: "agent",
    name: "Build Agent",
    handle: "build-agent"
  });
  const project = createProject(context.context, {
    name: "Platform Foundations",
    description: "Fictional migration project.",
    status: "planned",
    leadId: agent.id,
    startDate: "2026-05-01",
    targetDate: "2026-06-01"
  });

  db.insert(milestones).values({
    id: uuid(),
    projectId: project.id,
    name: "Snapshot Ready",
    targetDate: "2026-05-15",
    position: 1
  }).run();

  context.context.clock = fixedClock("2026-05-01T00:01:00.000Z");
  const cycle = createCycle(context.context, {
    team: "ENG",
    name: "Cycle 1",
    startsAt: "2026-05-01T00:00:00.000Z",
    endsAt: "2026-05-15T00:00:00.000Z"
  });
  createLabel(context.context, { name: "Migration", color: "#22C55E", group: "Type" });
  createLabel(context.context, { name: "Bug", color: "#EF4444" });

  context.context.clock = fixedClock("2026-05-01T00:02:00.000Z");
  const parent = createIssue(context.context, {
    title: "Import fictional workspace",
    description: "Make snapshot data portable.",
    project: project.name,
    cycle: cycle.number,
    priority: 2,
    labels: ["Migration"],
    estimate: 3,
    dueDate: "2026-05-10"
  });

  context.context.clock = fixedClock("2026-05-01T00:03:00.000Z");
  const child = createIssue(context.context, {
    title: "Preserve child issue",
    description: "Keep parent and child IDs intact.",
    assignee: agent.handle,
    project: project.name,
    cycle: cycle.number,
    parent: parent.identifier,
    priority: 1,
    labels: ["Bug"]
  });

  context.context.clock = fixedClock("2026-05-01T00:04:00.000Z");
  const comment = addComment(context.context, {
    issue: child.identifier,
    body: "Snapshot includes parent comments."
  });

  context.context.clock = fixedClock("2026-05-01T00:05:00.000Z");
  addComment(context.context, {
    issue: child.identifier,
    body: "Snapshot includes replies.",
    parent: comment.id
  });

  context.context.clock = fixedClock("2026-05-01T00:06:00.000Z");
  addAttachment(context.context, {
    issue: child.identifier,
    kind: "branch",
    title: "Import branch",
    repoPath: "/fictional/repo",
    remote: "origin",
    branchName: "lf-89-import"
  });

  context.context.clock = fixedClock("2026-05-01T00:07:00.000Z");
  createSavedView(context.context, {
    name: "Migration bugs",
    filters: { label: "Bug", priority: 1 },
    description: "Fictional import view."
  });
  createTemplate(context.context, {
    name: "Migration task",
    title: "Plan fictional migration",
    description: "Use the import checklist.",
    priority: 2,
    team: "ENG",
    project: project.name,
    labels: ["Migration"]
  });

  return context;
}

function initializedContext(now: string) {
  const context = emptyContext(now);
  init(context.context);
  context.context.actor = whoami(context.context);
  return context;
}

function emptyContext(now = "2026-05-01T00:00:00.000Z") {
  const db = openTempDb();
  applyMigrations(db);

  const context: ServiceContext = { db, actor: null, clock: fixedClock(now) };

  return {
    context,
    db,
    close: () => db.$client.close()
  };
}

function openTempDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-import-"));
  tempDirs.push(tempDir);

  return openDb(join(tempDir, "tracker.db"));
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}
