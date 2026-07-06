import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  addComment,
  addCommentInputSchema,
  applyMigrations,
  archiveLabel,
  AppErrorCode,
  attachLabel,
  createCycle,
  createIssue,
  createIssueInputSchema,
  createLabel,
  createProject,
  createTeam,
  detachLabel,
  getIssue,
  init,
  listComments,
  listCycles,
  listLabels,
  listIssueFiltersSchema,
  listIssues,
  moveIssue,
  openDb,
  serializeIssue,
  serializeCycle,
  updateIssue,
  updateIssueInputSchema,
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

  it("creates, lists, archives, and enforces grouped label uniqueness", () => {
    const { context, close } = initializedContext();

    try {
      const bug = createLabel(context, { name: "Bug", color: "#EF4444" });
      const groupedBug = createLabel(context, {
        name: "Bug",
        color: "#F97316",
        group: "Type"
      });

      expect(listLabels(context).map((label) => [label.name, label.group])).toEqual([
        ["Bug", null],
        ["Bug", "Type"]
      ]);
      expect(() => createLabel(context, { name: "Bug", color: "#DC2626" })).toThrow(
        "already exists"
      );
      expect(() =>
        createLabel(context, { name: "Bug", color: "#EA580C", group: "Type" })
      ).toThrow("already exists");

      const archived = archiveLabel(context, bug.id);

      expect(archived.archivedAt).toEqual(expect.any(String));
      expect(listLabels(context).map((label) => label.id)).toEqual([groupedBug.id]);
      expect(listLabels(context, { includeArchived: true }).map((label) => label.id)).toEqual([
        bug.id,
        groupedBug.id
      ]);
    } finally {
      close();
    }
  });

  it("tags issues on create and update, filters by label name, and serializes labels", () => {
    const { context, close } = initializedContext();

    try {
      createLabel(context, { name: "Bug", color: "#EF4444" });
      createLabel(context, { name: "Docs", color: "#22C55E" });

      const created = createIssue(context, {
        title: "Fix login redirect",
        labels: ["Bug"]
      });
      createIssue(context, { title: "Refresh setup guide" });

      expect(created.labels.map((label) => label.name)).toEqual(["Bug"]);
      expect(serializeIssue(created).labels).toEqual([
        expect.objectContaining({ name: "Bug", group: null })
      ]);
      expect(listIssues(context, { label: "Bug" }).map((issue) => issue.identifier)).toEqual([
        "ENG-1"
      ]);

      const updated = updateIssue(context, "ENG-1", { labels: ["Docs"] });
      expect(updated.labels.map((label) => label.name)).toEqual(["Bug", "Docs"]);

      const removed = updateIssue(context, "ENG-1", { removeLabels: ["Bug"] });
      expect(removed.labels.map((label) => label.name)).toEqual(["Docs"]);
      expect(listIssues(context, { label: "Bug" })).toHaveLength(0);
      expect(listIssues(context, { label: "Docs" }).map((issue) => issue.identifier)).toEqual([
        "ENG-1"
      ]);
    } finally {
      close();
    }
  });

  it("creates, lists, serializes, and enforces per-team cycle numbers", () => {
    const { context, close } = initializedContext("2026-04-01T00:00:00.000Z");

    try {
      createTeam(context, { key: "OPS", name: "Operations" });

      const first = createCycle(context, {
        team: "ENG",
        name: "Cycle 1",
        startsAt: "2026-04-01T00:00:00.000Z",
        endsAt: "2026-04-15T00:00:00.000Z"
      });
      const second = createCycle(context, { team: "ENG", name: "Cycle 2" });
      const opsFirst = createCycle(context, { team: "OPS", number: 1 });

      expect(first.number).toBe(1);
      expect(second.number).toBe(2);
      expect(opsFirst.number).toBe(1);
      expect(listCycles(context, { team: "ENG" }).map((cycle) => cycle.number)).toEqual([1, 2]);
      expect(serializeCycle(first)).toMatchObject({
        number: 1,
        name: "Cycle 1",
        startsAt: "2026-04-01T00:00:00.000Z",
        endsAt: "2026-04-15T00:00:00.000Z"
      });
      expect(serializeCycle(second)).toMatchObject({
        name: "Cycle 2",
        startsAt: "2026-04-01T00:00:00.000Z",
        endsAt: "2026-04-01T00:00:00.000Z"
      });
      expect(() => createCycle(context, { team: "ENG", number: 1 })).toThrow(
        "already exists"
      );
    } finally {
      close();
    }
  });

  it("assigns issues to cycles on create and update, then filters by cycle", () => {
    const { context, close } = initializedContext();

    try {
      const first = createCycle(context, { team: "ENG", name: "Cycle 1" });
      const second = createCycle(context, { team: "ENG", name: "Cycle 2" });

      const created = createIssue(context, {
        title: "Fix cycle assignment",
        cycle: 1
      });
      createIssue(context, { title: "Schedule next work" });

      expect(created.cycleId).toBe(first.id);
      expect(listIssues(context, { cycle: 1 }).map((issue) => issue.identifier)).toEqual([
        "ENG-1"
      ]);

      const updated = updateIssue(context, "ENG-2", { cycle: second.id });
      expect(updated.cycleId).toBe(second.id);
      expect(listIssues(context, { cycle: second.id }).map((issue) => issue.identifier)).toEqual([
        "ENG-2"
      ]);
      expect(serializeIssue(updated).cycleId).toBe(second.id);
      expect(() => updateIssue(context, "ENG-2", { cycle: 999 })).toThrow("was not found");
    } finally {
      close();
    }
  });

  it("links sub-issues by parent reference without changing top-level numbering", () => {
    const { context, close } = initializedContext();

    try {
      const parent = createIssue(context, { title: "Build issue hierarchy" });
      const child = createIssue(context, {
        title: "Add child issue",
        parent: parent.identifier
      });
      const sibling = createIssue(context, { title: "Keep next top-level number" });

      expect(child.identifier).toBe("ENG-2");
      expect(child.parentId).toBe(parent.id);
      expect(sibling.identifier).toBe("ENG-3");

      const parentView = getIssue(context, parent.identifier);
      const childView = getIssue(context, child.identifier);

      expect(parentView.parent).toBeNull();
      expect(parentView.children).toEqual([
        {
          id: child.id,
          identifier: "ENG-2",
          teamId: child.teamId,
          number: 2,
          title: "Add child issue"
        }
      ]);
      expect(childView.parent).toEqual({
        id: parent.id,
        identifier: "ENG-1",
        teamId: parent.teamId,
        number: 1,
        title: "Build issue hierarchy"
      });
      expect(childView.children).toEqual([]);
      expect(serializeIssue(childView)).toMatchObject({
        parentId: parent.id,
        parent: { identifier: "ENG-1" },
        children: []
      });
    } finally {
      close();
    }
  });

  it("updates and clears parent links by identifier or raw id and records activity", () => {
    const { context, db, close } = initializedContext();

    try {
      const firstParent = createIssue(context, { title: "First parent" });
      const secondParent = createIssue(context, { title: "Second parent" });
      createIssue(context, { title: "Retarget child" });

      const assigned = updateIssue(context, "ENG-3", { parent: firstParent.identifier });
      expect(assigned.parentId).toBe(firstParent.id);
      expect(assigned.parent).toMatchObject({ identifier: "ENG-1" });

      const retargeted = updateIssue(context, "ENG-3", { parentId: secondParent.id });
      expect(retargeted.parentId).toBe(secondParent.id);
      expect(retargeted.parent).toMatchObject({ identifier: "ENG-2" });

      const cleared = updateIssue(context, "ENG-3", { parent: null });
      expect(cleared.parentId).toBeNull();
      expect(cleared.parent).toBeNull();

      expect(readActivityEntries(db)).toMatchObject([
        { action: "created" },
        { action: "created" },
        { action: "created" },
        { action: "updated", data: { changed: { parentId: firstParent.id } } },
        { action: "updated", data: { changed: { parentId: secondParent.id } } },
        { action: "updated", data: { changed: { parentId: null } } }
      ]);
    } finally {
      close();
    }
  });

  it("rejects self-parenting and descendant-parent cycles", () => {
    const { context, close } = initializedContext();

    try {
      const parent = createIssue(context, { title: "Parent issue" });
      const child = createIssue(context, { title: "Child issue", parent: parent.identifier });
      const grandchild = createIssue(context, {
        title: "Grandchild issue",
        parent: child.identifier
      });

      expectIssueParentCycle(() =>
        updateIssue(context, parent.identifier, { parent: parent.identifier })
      );
      expectIssueParentCycle(() =>
        updateIssue(context, parent.identifier, { parent: grandchild.identifier })
      );
      expect(getIssue(context, parent.identifier).parentId).toBeNull();
    } finally {
      close();
    }
  });

  it("matches state names across teams when no team filter is supplied", () => {
    const { context, close } = initializedContext();

    try {
      createTeam(context, { key: "OPS", name: "Operations" });
      createIssue(context, { title: "Triage engineering backlog", team: "ENG" });
      createIssue(context, { title: "Triage operations backlog", team: "OPS" });

      expect(
        listIssues(context, { state: "Todo" })
          .map((issue) => issue.identifier)
          .sort()
      ).toEqual(["ENG-1", "OPS-1"]);
    } finally {
      close();
    }
  });

  it("filters listed issues by priority", () => {
    const { context, close } = initializedContext();

    try {
      createIssue(context, { title: "Patch urgent regression", priority: 1 });
      createIssue(context, { title: "Improve onboarding copy", priority: 3 });
      createIssue(context, { title: "Investigate flaky setup", priority: 1 });

      expect(listIssues(context, { priority: 1 }).map((issue) => issue.identifier)).toEqual([
        "ENG-1",
        "ENG-3"
      ]);
    } finally {
      close();
    }
  });

  it("rejects out-of-range priorities at the validation boundary", () => {
    for (const priority of [-1, 99]) {
      expect(
        createIssueInputSchema.safeParse({ title: "Validate priority", priority }).success
      ).toBe(false);
      expect(updateIssueInputSchema.safeParse({ priority }).success).toBe(false);
      expect(listIssueFiltersSchema.safeParse({ priority }).success).toBe(false);
    }
  });

  it("adds comments and threaded replies with authors and serializes them on issues", () => {
    const { context, close } = initializedContext("2026-05-01T00:00:00.000Z");

    try {
      const issue = createIssue(context, { title: "Review agent notes" });

      context.clock = fixedClock("2026-05-01T00:01:00.000Z");
      const root = addComment(context, {
        issue: issue.identifier,
        body: "Initial investigation complete."
      });

      context.clock = fixedClock("2026-05-01T00:02:00.000Z");
      const reply = addComment(context, {
        issue: issue.id,
        body: "Follow-up captured in the same thread.",
        parent: root.id
      });

      expect(root).toMatchObject({
        issueId: issue.id,
        authorId: context.actor?.id,
        body: "Initial investigation complete.",
        parentId: null,
        createdAt: "2026-05-01T00:01:00.000Z",
        author: { handle: "owner" }
      });
      expect(reply).toMatchObject({
        issueId: issue.id,
        authorId: context.actor?.id,
        body: "Follow-up captured in the same thread.",
        parentId: root.id,
        createdAt: "2026-05-01T00:02:00.000Z",
        author: { handle: "owner" }
      });
      expect(
        listComments(context, { issue: "ENG-1" }).map((comment) => ({
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

      const serialized = serializeIssue(getIssue(context, "ENG-1"));
      expect(serialized.comments).toEqual([
        expect.objectContaining({
          id: root.id,
          body: "Initial investigation complete.",
          parentId: null,
          author: expect.objectContaining({ handle: "owner" })
        }),
        expect.objectContaining({
          id: reply.id,
          body: "Follow-up captured in the same thread.",
          parentId: root.id,
          author: expect.objectContaining({ handle: "owner" })
        })
      ]);
      expect(addCommentInputSchema.safeParse({ issue: "ENG-1", body: "" }).success).toBe(false);
    } finally {
      close();
    }
  });

  it("rejects threaded replies whose parent comment is missing or belongs to another issue", () => {
    const { context, close } = initializedContext();

    try {
      const first = createIssue(context, { title: "First issue" });
      const second = createIssue(context, { title: "Second issue" });
      const root = addComment(context, {
        issue: first.identifier,
        body: "Root comment"
      });

      expect(() =>
        addComment(context, {
          issue: first.identifier,
          body: "Missing parent",
          parent: "comment-missing"
        })
      ).toThrow("Comment comment-missing was not found.");
      expect(() =>
        addComment(context, {
          issue: second.identifier,
          body: "Cross-issue reply",
          parent: root.id
        })
      ).toThrow("does not belong to issue");
      expect(listComments(context, { issue: second.identifier })).toEqual([]);
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

  it("writes exactly one activity row when attaching or detaching a label", () => {
    const { context, db, close } = initializedContext();

    try {
      const issue = createIssue(context, { title: "Track label activity" });
      const label = createLabel(context, { name: "Bug", color: "#EF4444" });

      attachLabel(context, issue.id, label.id);
      expect(readActivityActions(db)).toEqual(["created", "label_added"]);

      detachLabel(context, issue.id, label.id);
      expect(readActivityActions(db)).toEqual(["created", "label_added", "label_removed"]);
    } finally {
      close();
    }
  });

  it("writes exactly one commented activity row for each comment", () => {
    const { context, db, close } = initializedContext();

    try {
      createIssue(context, { title: "Track comment activity" });
      const root = addComment(context, { issue: "ENG-1", body: "Root comment" });
      addComment(context, {
        issue: "ENG-1",
        body: "Threaded reply",
        parent: root.id
      });

      expect(readActivityEntries(db)).toMatchObject([
        { action: "created" },
        { action: "commented", data: { commentId: root.id, parentId: null } },
        { action: "commented", data: { parentId: root.id } }
      ]);
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
        "parent",
        "children",
        "comments",
        "estimate",
        "dueDate",
        "sortOrder",
        "createdAt",
        "updatedAt",
        "startedAt",
        "completedAt",
        "canceledAt",
        "archivedAt",
        "labels"
      ]);
      expect(serialized).toMatchObject({
        identifier: "ENG-1",
        description: null,
        assigneeId: null,
        projectId: null,
        cycleId: null,
        parentId: null,
        parent: null,
        children: [],
        comments: [],
        estimate: null,
        dueDate: null,
        startedAt: null,
        completedAt: null,
        canceledAt: null,
        archivedAt: null,
        labels: [],
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

function readActivityEntries(db: Db): Array<{ action: string; data: unknown }> {
  const rows = db.$client
    .prepare("select action, data from activity order by rowid")
    .all() as Array<{ action: string; data: string | unknown }>;

  return rows.map((entry) => ({
    action: entry.action,
    data: typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data
  }));
}

function expectIssueParentCycle(work: () => unknown): void {
  let error: unknown;

  try {
    work();
  } catch (caught) {
    error = caught;
  }

  expect(error).toMatchObject({ code: AppErrorCode.ISSUE_PARENT_CYCLE });
}
