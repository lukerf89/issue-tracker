import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  addAttachment,
  addComment,
  addCommentInputSchema,
  appendActivity,
  applyMigrations,
  archiveIssue,
  archiveLabel,
  archiveProject,
  archiveTeam,
  assignIssue,
  assignIssueInputSchema,
  AppErrorCode,
  attachLabel,
  ConfigKey,
  createActor,
  createCycle,
  createIssue,
  createIssueFromTemplate,
  createIssueInputSchema,
  createLabel,
  createProject,
  createProjectInputSchema,
  createSavedView,
  createSavedViewInputSchema,
  createTeam,
  createTemplate,
  createTemplateInputSchema,
  deleteSavedView,
  deleteTemplate,
  detachLabel,
  getIssue,
  getProject,
  getState,
  getTeam,
  getTeamByKey,
  init,
  listActivity,
  listActivitySince,
  linkIssueInputSchema,
  listActors,
  listAttachments,
  listComments,
  listCycles,
  listLabels,
  listIssueFiltersSchema,
  listIssuesWithView,
  listIssues,
  listProjects,
  listSavedViews,
  listTemplates,
  listTeams,
  moveIssue,
  openDb,
  searchInputSchema,
  searchIssues,
  seedDefaultWorkflowStates,
  serializeIssue,
  serializeAttachment,
  serializeActivity,
  serializeActivityEvent,
  serializeCycle,
  serializeSavedView,
  serializeTemplate,
  setConfig,
  unarchiveIssue,
  unarchiveLabel,
  unarchiveProject,
  unarchiveTeam,
  updateIssue,
  updateIssueInputSchema,
  updateProject,
  updateProjectInputSchema,
  whoami,
  resolveIssueListFilters,
  resolveSavedView,
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

  it("creates actors, assigns and clears issues, filters by assignee, and records assigned activity", () => {
    const { context, db, close } = initializedContext();

    try {
      const agent = createActor(context, {
        type: "agent",
        name: "Build Agent",
        handle: "build-agent"
      });
      const issue = createIssue(context, { title: "Route agent work" });

      expect(listActors(context).map((actor) => [actor.handle, actor.type])).toEqual([
        ["build-agent", "agent"],
        ["owner", "human"]
      ]);
      expect(() =>
        createActor(context, {
          type: "agent",
          name: "Duplicate Agent",
          handle: "build-agent"
        })
      ).toThrow("already taken");

      context.clock = fixedClock("2026-01-01T00:05:00.000Z");
      const assigned = assignIssue(context, issue.identifier, "build-agent");
      expect(assigned.assigneeId).toBe(agent.id);
      expect(assigned.updatedAt).toBe("2026-01-01T00:05:00.000Z");
      expect(listIssues(context, { assignee: "build-agent" }).map((item) => item.identifier)).toEqual([
        "ENG-1"
      ]);
      expect(listIssues(context, { assignee: agent.id }).map((item) => item.identifier)).toEqual([
        "ENG-1"
      ]);
      expect(listIssues(context, { assignee: null })).toEqual([]);

      context.clock = fixedClock("2026-01-01T00:06:00.000Z");
      const cleared = assignIssue(context, issue.id, null);
      expect(cleared.assigneeId).toBeNull();
      expect(cleared.updatedAt).toBe("2026-01-01T00:06:00.000Z");
      expect(listIssues(context, { assignee: null }).map((item) => item.identifier)).toEqual([
        "ENG-1"
      ]);

      expect(readActivityEntries(db)).toMatchObject([
        { action: "created" },
        {
          action: "assigned",
          data: {
            from: null,
            to: agent.id,
            fromHandle: null,
            toHandle: "build-agent"
          }
        },
        {
          action: "assigned",
          data: {
            from: agent.id,
            to: null,
            fromHandle: "build-agent",
            toHandle: null
          }
        }
      ]);
      expect(assignIssueInputSchema.safeParse({ identifier: "ENG-1", actor: null }).success).toBe(
        true
      );
      expect(assignIssueInputSchema.safeParse({ identifier: "ENG-1", actor: "" }).success).toBe(
        false
      );
    } finally {
      close();
    }
  });

  it("normalizes default actor and team config values from handles and keys", () => {
    const { context, close } = initializedContext();

    try {
      const agent = createActor(context, {
        type: "agent",
        name: "Build Agent",
        handle: "build-agent"
      });
      const ops = createTeam(context, {
        key: "OPS",
        name: "Operations"
      });

      setConfig(context, ConfigKey.DEFAULT_ACTOR, agent.handle);
      expect(whoami(context).id).toBe(agent.id);

      setConfig(context, ConfigKey.DEFAULT_TEAM, ops.key.toLowerCase());
      context.actor = whoami(context);
      const issue = createIssue(context, { title: "Route operational work" });
      expect(issue.identifier).toBe("OPS-1");

      expectAppError(
        () => setConfig(context, ConfigKey.DEFAULT_ACTOR, "missing-agent"),
        AppErrorCode.ACTOR_NOT_FOUND
      );
      expectAppError(
        () => setConfig(context, ConfigKey.DEFAULT_TEAM, "missing-team"),
        AppErrorCode.TEAM_NOT_FOUND
      );
    } finally {
      close();
    }
  });

  it("rejects invalid date-only values through shared input schemas", () => {
    expect(createIssueInputSchema.safeParse({
      title: "Reject impossible due date",
      dueDate: "2026-02-30"
    }).success).toBe(false);
    expect(updateIssueInputSchema.safeParse({ dueDate: "not-a-date" }).success).toBe(false);
    expect(createProjectInputSchema.safeParse({
      name: "Reject impossible project date",
      startDate: "2026-02-30"
    }).success).toBe(false);
    expect(updateProjectInputSchema.safeParse({ targetDate: "not-a-date" }).success).toBe(false);

    expect(createIssueInputSchema.safeParse({
      title: "Accept due date",
      dueDate: "2026-02-28"
    }).success).toBe(true);
    expect(createProjectInputSchema.safeParse({
      name: "Accept project dates",
      startDate: "2026-02-01",
      targetDate: "2026-02-28"
    }).success).toBe(true);
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

  it("unarchives issues and labels, rejects active unarchive, and retains label links", () => {
    const { context, db, close } = initializedContext();

    try {
      createLabel(context, { name: "Bug", color: "#EF4444" });
      const issue = createIssue(context, {
        title: "Restore archived work",
        labels: ["Bug"]
      });

      context.clock = fixedClock("2026-01-01T00:10:00.000Z");
      const archivedIssue = archiveIssue(context, issue.identifier);
      const archivedLabel = archiveLabel(context, "Bug");

      expect(archivedIssue.archivedAt).toBe("2026-01-01T00:10:00.000Z");
      expect(archivedLabel.archivedAt).toBe("2026-01-01T00:10:00.000Z");
      expect(listIssues(context)).toEqual([]);
      expect(listLabels(context)).toEqual([]);
      expect(getIssue(context, issue.identifier).labels).toEqual([]);

      context.clock = fixedClock("2026-01-01T00:20:00.000Z");
      const restoredIssue = unarchiveIssue(context, issue.id);
      const restoredLabel = unarchiveLabel(context, archivedLabel.id);

      expect(restoredIssue.archivedAt).toBeNull();
      expect(restoredIssue.updatedAt).toBe("2026-01-01T00:20:00.000Z");
      expect(restoredLabel.archivedAt).toBeNull();
      expect(listIssues(context).map((listed) => listed.identifier)).toEqual([
        issue.identifier
      ]);
      expect(listLabels(context).map((label) => label.name)).toEqual(["Bug"]);
      expect(getIssue(context, issue.identifier).labels.map((label) => label.name)).toEqual([
        "Bug"
      ]);
      expect(() => unarchiveIssue(context, issue.identifier)).toThrow("not archived");
      expect(() => unarchiveLabel(context, "Bug")).toThrow("not archived");
      expect(readActivityEntries(db).map((entry) => entry.action)).toEqual([
        "created",
        "label_added",
        "archived",
        "unarchived"
      ]);
    } finally {
      close();
    }
  });

  it("archives and unarchives teams and projects while retaining related issues", () => {
    const { context, close } = initializedContext();

    try {
      const operations = createTeam(context, { key: "OPS", name: "Operations" });
      const project = createProject(context, {
        name: "Platform Foundations",
        status: "planned"
      });
      const issue = createIssue(context, {
        title: "Keep related issue addressable",
        team: "OPS",
        project: project.name
      });

      context.clock = fixedClock("2026-01-01T00:30:00.000Z");
      const archivedTeam = archiveTeam(context, "ops");
      const archivedProject = archiveProject(context, project.name);

      expect(archivedTeam).toMatchObject({
        id: operations.id,
        key: "OPS",
        archivedAt: "2026-01-01T00:30:00.000Z"
      });
      expect(archivedProject).toMatchObject({
        id: project.id,
        archivedAt: "2026-01-01T00:30:00.000Z"
      });
      expect(listTeams(context).map((team) => team.key)).toEqual(["ENG"]);
      expect(listTeams(context, { includeArchived: true }).map((team) => team.key)).toEqual([
        "ENG",
        "OPS"
      ]);
      expect(listProjects(context)).toEqual([]);
      expect(listProjects(context, { includeArchived: true }).map((item) => item.id)).toEqual([
        project.id
      ]);
      expect(getTeam(context, operations.id).archivedAt).toBe("2026-01-01T00:30:00.000Z");
      expect(getTeamByKey(context, "OPS").archivedAt).toBe("2026-01-01T00:30:00.000Z");
      expect(getProject(context, project.id).archivedAt).toBe("2026-01-01T00:30:00.000Z");
      expect(getProject(context, project.name).archivedAt).toBe("2026-01-01T00:30:00.000Z");
      expect(getIssue(context, issue.identifier)).toMatchObject({
        identifier: "OPS-1",
        teamId: operations.id,
        projectId: project.id
      });
      expect(listIssues(context, { team: "OPS" }).map((listed) => listed.identifier)).toEqual([
        "OPS-1"
      ]);
      expect(() => archiveTeam(context, operations.id)).toThrow("already archived");
      expect(() => archiveProject(context, project.id)).toThrow("already archived");

      const restoredTeam = unarchiveTeam(context, operations.id);
      const restoredProject = unarchiveProject(context, project.id);

      expect(restoredTeam.archivedAt).toBeNull();
      expect(restoredProject.archivedAt).toBeNull();
      expect(listTeams(context).map((team) => team.key)).toEqual(["ENG", "OPS"]);
      expect(listProjects(context).map((item) => item.id)).toEqual([project.id]);
      expect(() => unarchiveTeam(context, "OPS")).toThrow("not archived");
      expect(() => unarchiveProject(context, project.name)).toThrow("not archived");
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

  it("composes issue list filters, orders by team key and number, and hides archived issues by default", () => {
    const { context, db, close } = initializedContext();

    try {
      createTeam(context, { key: "OPS", name: "Operations" });
      createActor(context, {
        type: "agent",
        name: "Build Agent",
        handle: "build-agent"
      });
      const project = createProject(context, {
        name: "Platform Foundations",
        status: "planned"
      });
      createLabel(context, { name: "Bug", color: "#EF4444" });
      createLabel(context, { name: "Docs", color: "#22C55E" });
      createCycle(context, { team: "ENG", name: "Cycle 1" });
      createCycle(context, { team: "OPS", name: "Cycle 1" });

      createIssue(context, {
        title: "Matching engineering issue",
        team: "ENG",
        assignee: "build-agent",
        project: project.id,
        cycle: 1,
        priority: 1,
        labels: ["Bug"]
      });
      createIssue(context, {
        title: "Wrong state",
        team: "ENG",
        assignee: "build-agent",
        project: project.id,
        cycle: 1,
        priority: 1,
        labels: ["Bug"]
      });
      createIssue(context, {
        title: "Wrong priority",
        team: "ENG",
        assignee: "build-agent",
        project: project.id,
        cycle: 1,
        priority: 2,
        labels: ["Bug"]
      });
      createIssue(context, {
        title: "Wrong label",
        team: "ENG",
        assignee: "build-agent",
        project: project.id,
        cycle: 1,
        priority: 1,
        labels: ["Docs"]
      });
      createIssue(context, {
        title: "Matching operations issue",
        team: "OPS",
        assignee: "build-agent",
        project: project.id,
        cycle: 1,
        priority: 1,
        labels: ["Bug"]
      });

      moveIssue(context, "ENG-1", "In Progress");
      moveIssue(context, "ENG-3", "In Progress");
      moveIssue(context, "ENG-4", "In Progress");
      moveIssue(context, "OPS-1", "In Progress");

      expect(listIssues(context, { team: "OPS" }).map((issue) => issue.identifier)).toEqual([
        "OPS-1"
      ]);
      expect(listIssues(context, { limit: 2 }).map((issue) => issue.identifier)).toEqual([
        "ENG-1",
        "ENG-2"
      ]);
      expect(
        listIssues(context, {
          state: "In Progress",
          assignee: "build-agent",
          project: project.id,
          cycle: 1,
          label: "Bug",
          priority: 1,
          team: "ENG"
        }).map((issue) => issue.identifier)
      ).toEqual(["ENG-1"]);

      context.clock = fixedClock("2026-01-01T00:30:00.000Z");
      const archived = archiveIssue(context, "ENG-1");

      expect(archived.archivedAt).toBe("2026-01-01T00:30:00.000Z");
      expect(getIssue(context, "ENG-1").archivedAt).toBe("2026-01-01T00:30:00.000Z");
      expect(
        listIssues(context, {
          state: "In Progress",
          assignee: "build-agent",
          project: project.id,
          cycle: 1,
          label: "Bug",
          priority: 1,
          team: "ENG"
        })
      ).toEqual([]);
      expect(
        listIssues(context, {
          state: "In Progress",
          assignee: "build-agent",
          project: project.id,
          cycle: 1,
          label: "Bug",
          priority: 1,
          team: "ENG",
          includeArchived: true
        }).map((issue) => issue.identifier)
      ).toEqual(["ENG-1"]);
      expect(readActivityEntries(db).at(-1)).toMatchObject({
        action: "archived",
        data: { identifier: "ENG-1" }
      });
    } finally {
      close();
    }
  });

  it("creates, lists, resolves, applies, and deletes saved view filters", () => {
    const { context, close } = initializedContext("2026-07-01T00:00:00.000Z");

    try {
      createLabel(context, { name: "Bug", color: "#EF4444" });
      createLabel(context, { name: "Docs", color: "#22C55E" });
      createIssue(context, {
        title: "Fix active bug",
        priority: 1,
        labels: ["Bug"]
      });
      createIssue(context, {
        title: "Fix later bug",
        priority: 2,
        labels: ["Bug"]
      });
      createIssue(context, {
        title: "Refresh docs",
        priority: 1,
        labels: ["Docs"]
      });

      const view = createSavedView(context, {
        name: "Priority bugs",
        filters: { label: "Bug", priority: 1 },
        description: "High-priority bug queue"
      });

      expect(view).toMatchObject({
        name: "Priority bugs",
        filters: { label: "Bug", priority: 1 },
        description: "High-priority bug queue",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      });
      expect(serializeSavedView(view)).toMatchObject({
        name: "Priority bugs",
        filters: { label: "Bug", priority: 1 },
        description: "High-priority bug queue",
        createdAt: "2026-07-01T00:00:00.000Z"
      });
      expect(listSavedViews(context).map((saved) => saved.name)).toEqual([
        "Priority bugs"
      ]);
      expect(resolveSavedView(context, "Priority bugs")).toEqual({
        label: "Bug",
        priority: 1
      });
      expect(listIssuesWithView(context, { view: "Priority bugs" }).map((issue) => issue.identifier)).toEqual([
        "ENG-1"
      ]);
      expect(
        resolveIssueListFilters(context, {
          view: "Priority bugs",
          filters: { priority: 2 }
        })
      ).toEqual({ label: "Bug", priority: 2 });
      expect(
        listIssuesWithView(context, {
          view: "Priority bugs",
          filters: { priority: 2 }
        }).map((issue) => issue.identifier)
      ).toEqual(["ENG-2"]);
      expectAppError(
        () =>
          createSavedView(context, {
            name: "Priority bugs",
            filters: { state: "Todo" }
          }),
        AppErrorCode.SAVED_VIEW_NAME_TAKEN
      );
      expect(
        createSavedViewInputSchema.safeParse({
          name: "Invalid priority",
          filters: { priority: 99 }
        }).success
      ).toBe(false);

      const deleted = deleteSavedView(context, view.id);
      expect(deleted.id).toBe(view.id);
      expect(listSavedViews(context)).toEqual([]);
      expectAppError(
        () => resolveSavedView(context, "Priority bugs"),
        AppErrorCode.SAVED_VIEW_NOT_FOUND
      );
    } finally {
      close();
    }
  });

  it("creates, lists, deletes, and creates issues from templates through createIssue", () => {
    const { context, db, close } = initializedContext("2026-07-02T00:00:00.000Z");

    try {
      createTeam(context, { key: "OPS", name: "Operations" });
      const project = createProject(context, {
        name: "Platform Foundations",
        status: "planned"
      });
      createLabel(context, { name: "Bug", color: "#EF4444" });

      const template = createTemplate(context, {
        name: "Bug report",
        title: "Investigate fictional bug",
        description: "Capture reproduction steps.",
        priority: 2,
        team: "ENG",
        project: project.name,
        labels: ["Bug"]
      });

      expect(template).toMatchObject({
        name: "Bug report",
        title: "Investigate fictional bug",
        description: "Capture reproduction steps.",
        priority: 2,
        team: "ENG",
        project: project.id,
        labels: ["Bug"],
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z"
      });
      expect(serializeTemplate(template)).toMatchObject({
        name: "Bug report",
        title: "Investigate fictional bug",
        priority: 2,
        labels: ["Bug"],
        createdAt: "2026-07-02T00:00:00.000Z"
      });
      expect(listTemplates(context).map((saved) => saved.name)).toEqual(["Bug report"]);

      updateProject(context, project.id, { name: "Platform Reliability" });

      context.clock = fixedClock("2026-07-02T00:10:00.000Z");
      const issue = createIssueFromTemplate(context, "Bug report", {
        title: "Investigate export bug",
        priority: 1
      });
      const state = getState(context, issue.stateId, issue.teamId);

      expect(issue).toMatchObject({
        identifier: "ENG-1",
        number: 1,
        title: "Investigate export bug",
        description: "Capture reproduction steps.",
        priority: 1,
        projectId: project.id,
        startedAt: null,
        completedAt: null,
        canceledAt: null
      });
      expect(state).toMatchObject({ name: "Todo", type: "unstarted" });
      expect(issue.labels.map((label) => label.name)).toEqual(["Bug"]);
      expect(readActivityEntries(db)).toMatchObject([
        { action: "created", data: { identifier: "ENG-1" } },
        { action: "label_added", data: { labelName: "Bug" } }
      ]);
      expect(getTeamByKey(context, "ENG").issueCounter).toBe(1);

      context.clock = fixedClock("2026-07-02T00:20:00.000Z");
      const operationsIssue = createIssueFromTemplate(context, "Bug report", {
        title: "Route operations bug",
        team: "OPS",
        labels: []
      });

      expect(operationsIssue).toMatchObject({
        identifier: "OPS-1",
        number: 1,
        title: "Route operations bug",
        labels: []
      });
      expect(getTeamByKey(context, "OPS").issueCounter).toBe(1);
      expectAppError(
        () =>
          createTemplate(context, {
            name: "Bug report",
            title: "Duplicate template"
          }),
        AppErrorCode.TEMPLATE_NAME_TAKEN
      );
      expect(
        createTemplateInputSchema.safeParse({
          name: "Invalid priority",
          priority: 99
        }).success
      ).toBe(false);
      expectAppError(
        () => createIssueFromTemplate(context, "Missing template", { title: "No template" }),
        AppErrorCode.TEMPLATE_NOT_FOUND
      );

      const deleted = deleteTemplate(context, template.name);
      expect(deleted.id).toBe(template.id);
      expect(listTemplates(context)).toEqual([]);
    } finally {
      close();
    }
  });

  it("searches issue titles and descriptions case-insensitively and hides archived issues", () => {
    const { context, close } = initializedContext();

    try {
      createTeam(context, { key: "OPS", name: "Operations" });
      createIssue(context, {
        title: "Fix Login Redirect",
        description: "OAuth callback fails",
        team: "ENG"
      });
      createIssue(context, {
        title: "Refresh setup guide",
        description: "Mention login redirect setup",
        team: "ENG"
      });
      createIssue(context, {
        title: "Login operations runbook",
        team: "OPS"
      });
      createIssue(context, {
        title: "Archived login cleanup",
        team: "ENG"
      });
      archiveIssue(context, "ENG-3");

      expect(searchIssues(context, { query: "LOGIN" }).map((issue) => issue.identifier)).toEqual([
        "ENG-1",
        "ENG-2",
        "OPS-1"
      ]);
      expect(
        searchIssues(context, { query: "oauth", team: "ENG" }).map((issue) => issue.identifier)
      ).toEqual(["ENG-1"]);
      expect(searchIssues(context, { query: "login", limit: 2 }).map((issue) => issue.identifier)).toEqual([
        "ENG-1",
        "ENG-2"
      ]);
      expect(searchInputSchema.safeParse({ query: "login", team: "ENG", limit: 2 }).success).toBe(
        true
      );
      expect(searchInputSchema.safeParse({ query: "" }).success).toBe(false);
    } finally {
      close();
    }
  });

  it("treats SQL LIKE wildcard characters in search queries literally", () => {
    const { context, close } = initializedContext();

    try {
      createIssue(context, { title: "Use 100% capacity" });
      createIssue(context, { title: "Read abc_def flag" });
      createIssue(context, { title: "Plain matching issue" });

      expect(searchIssues(context, { query: "%" }).map((issue) => issue.identifier)).toEqual([
        "ENG-1"
      ]);
      expect(searchIssues(context, { query: "_" }).map((issue) => issue.identifier)).toEqual([
        "ENG-2"
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

  it("adds, lists, validates, and serializes repo-aware attachments with linked activity", () => {
    const { context, db, close } = initializedContext("2026-05-01T00:00:00.000Z");

    try {
      const issue = createIssue(context, { title: "Trace agent output" });

      context.clock = fixedClock("2026-05-01T00:01:00.000Z");
      const link = addAttachment(context, {
        issue: issue.identifier,
        kind: "link",
        url: "https://example.invalid/design-note",
        title: "Design note"
      });

      context.clock = fixedClock("2026-05-01T00:02:00.000Z");
      const branch = addAttachment(context, {
        issue: issue.id,
        kind: "branch",
        repoPath: "/workspace/fictional-app",
        remote: "origin",
        branchName: "lf-73-attachments"
      });

      context.clock = fixedClock("2026-05-01T00:03:00.000Z");
      const pr = addAttachment(context, {
        issue: issue.identifier,
        kind: "pr",
        repoPath: "/workspace/fictional-app",
        url: "https://example.invalid/fictional-app/pull/73"
      });

      context.clock = fixedClock("2026-05-01T00:04:00.000Z");
      const commit = addAttachment(context, {
        issue: issue.identifier,
        kind: "commit",
        repoPath: "/workspace/fictional-app",
        commitSha: "abc123def456"
      });

      expect(link).toMatchObject({
        issueId: issue.id,
        kind: "link",
        title: "Design note",
        url: "https://example.invalid/design-note",
        repoPath: null,
        createdAt: "2026-05-01T00:01:00.000Z"
      });
      expect(branch).toMatchObject({
        issueId: issue.id,
        kind: "branch",
        title: "lf-73-attachments",
        repoPath: "/workspace/fictional-app",
        remote: "origin",
        branchName: "lf-73-attachments",
        url: null,
        commitSha: null
      });
      expect(pr).toMatchObject({
        kind: "pr",
        title: "https://example.invalid/fictional-app/pull/73",
        repoPath: "/workspace/fictional-app",
        url: "https://example.invalid/fictional-app/pull/73"
      });
      expect(commit).toMatchObject({
        kind: "commit",
        title: "abc123def456",
        repoPath: "/workspace/fictional-app",
        commitSha: "abc123def456"
      });
      expect(listAttachments(context, { issue: issue.identifier }).map((item) => item.id)).toEqual([
        link.id,
        branch.id,
        pr.id,
        commit.id
      ]);

      const serialized = serializeIssue(getIssue(context, issue.identifier));
      expect(serialized.attachments).toEqual([
        serializeAttachment(link),
        serializeAttachment(branch),
        serializeAttachment(pr),
        serializeAttachment(commit)
      ]);
      expect(serialized.updatedAt).toBe("2026-05-01T00:04:00.000Z");

      expect(readActivityEntries(db)).toMatchObject([
        { action: "created" },
        { action: "linked", data: { attachmentId: link.id, kind: "link", repoPath: null } },
        {
          action: "linked",
          data: {
            attachmentId: branch.id,
            kind: "branch",
            repoPath: "/workspace/fictional-app",
            branchName: "lf-73-attachments"
          }
        },
        {
          action: "linked",
          data: {
            attachmentId: pr.id,
            kind: "pr",
            repoPath: "/workspace/fictional-app",
            url: "https://example.invalid/fictional-app/pull/73"
          }
        },
        {
          action: "linked",
          data: {
            attachmentId: commit.id,
            kind: "commit",
            repoPath: "/workspace/fictional-app",
            commitSha: "abc123def456"
          }
        }
      ]);

      expect(() => addAttachment(context, { issue: issue.identifier, kind: "link" })).toThrow(
        "Attachment kind link requires url."
      );
      expect(() =>
        addAttachment(context, {
          issue: issue.identifier,
          kind: "branch",
          repoPath: "/workspace/fictional-app"
        })
      ).toThrow("Attachment kind branch requires branchName.");
      expect(() =>
        addAttachment(context, {
          issue: issue.identifier,
          kind: "pr",
          url: "https://example.invalid/fictional-app/pull/74"
        })
      ).toThrow("Attachment kind pr requires repoPath.");
      expect(() =>
        addAttachment(context, {
          issue: issue.identifier,
          kind: "commit",
          repoPath: "/workspace/fictional-app"
        })
      ).toThrow("Attachment kind commit requires commitSha.");

      expect(
        linkIssueInputSchema.safeParse({
          issue: issue.identifier,
          kind: "commit",
          repoPath: "/workspace/fictional-app",
          commitSha: "abc123def456"
        }).success
      ).toBe(true);
      expect(
        linkIssueInputSchema.safeParse({
          issue: issue.identifier,
          kind: "branch",
          repoPath: "/workspace/fictional-app"
        }).success
      ).toBe(false);
    } finally {
      close();
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
    const { context, db, close } = initializedContext("2026-02-01T00:00:00.000Z");

    try {
      createIssue(context, { title: "Implement lifecycle states" });

      context.clock = fixedClock("2026-02-01T01:00:00.000Z");
      const started = moveIssue(context, "ENG-1", "In Progress");
      expect(started.startedAt).toBe("2026-02-01T01:00:00.000Z");
      expect(started.completedAt).toBeNull();
      expect(started.canceledAt).toBeNull();

      context.clock = fixedClock("2026-02-01T01:30:00.000Z");
      const stillStarted = moveIssue(context, "ENG-1", "In Progress");
      expect(stillStarted.updatedAt).toBe(started.updatedAt);
      expect(readActivityActions(db)).toEqual(["created", "state_changed"]);

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

  it("uses immediate transactions for public mutating service boundaries", () => {
    const db = openTempDb();
    applyMigrations(db);
    const transactionOptions = recordTransactionOptions(db);
    const context: ServiceContext = {
      db,
      actor: null,
      clock: fixedClock("2026-01-01T00:00:00.000Z")
    };

    try {
      init(context);
      context.actor = whoami(context);

      const actor = context.actor;
      if (!actor) {
        throw new Error("Expected init to configure the default actor.");
      }

      createActor(context, {
        type: "agent",
        name: "Build Agent",
        handle: "build-agent"
      });
      createTeam(context, { key: "OPS", name: "Operations" });
      db.insert(teams).values({ id: "team-raw", key: "RAW", name: "Raw Team" }).run();
      seedDefaultWorkflowStates(context, "team-raw");
      setConfig(context, "test_flag", "enabled");
      createLabel(context, { name: "Bug", color: "#EF4444" });
      createProject(context, { name: "Platform Foundations", status: "planned" });

      const issue = createIssue(context, { title: "Check transaction behavior" });
      addAttachment(context, {
        issue: issue.identifier,
        kind: "link",
        url: "https://example.invalid/transaction-link"
      });
      appendActivity(context, {
        issueId: issue.id,
        actorId: actor.id,
        action: "audited",
        data: { source: "transaction-test" }
      });

      expect(transactionOptions).toEqual(
        Array.from({ length: 10 }, () => ({ behavior: "immediate" }))
      );
    } finally {
      db.$client.close();
    }
  });

  it("allocates distinct gapless issue numbers across two WAL connections", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-services-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "tracker.db");
    const firstDb = openDb(dbPath);
    const secondDb = openDb(dbPath);

    try {
      applyMigrations(firstDb);

      const firstContext: ServiceContext = {
        db: firstDb,
        actor: null,
        clock: fixedClock("2026-01-01T00:00:00.000Z")
      };
      init(firstContext);
      firstContext.actor = whoami(firstContext);

      const secondContext: ServiceContext = {
        db: secondDb,
        actor: whoami({ ...firstContext, db: secondDb }),
        clock: fixedClock("2026-01-01T00:01:00.000Z")
      };

      const first = createIssue(firstContext, { title: "Create from first connection" });
      const second = createIssue(secondContext, { title: "Create from second connection" });

      expect([first.number, second.number]).toEqual([1, 2]);
      expect([first.identifier, second.identifier]).toEqual(["ENG-1", "ENG-2"]);
      expect(new Set([first.identifier, second.identifier]).size).toBe(2);

      const [team] = secondDb.select().from(teams).where(eq(teams.key, "ENG")).all();
      expect(team?.issueCounter).toBe(2);
    } finally {
      firstDb.$client.close();
      secondDb.$client.close();
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

  it("lists and serializes one ordered activity row for every issue mutation type", () => {
    const { context, close } = initializedContext("2026-06-01T00:00:00.000Z");

    try {
      const assignee = createActor(context, {
        type: "agent",
        name: "Build Agent",
        handle: "build-agent"
      });
      const label = createLabel(context, { name: "Bug", color: "#EF4444" });
      const cycle = createCycle(context, { team: "ENG", name: "Cycle 1" });
      const parent = createIssue(context, { title: "Parent issue" });

      context.clock = fixedClock("2026-06-01T00:01:00.000Z");
      const issue = createIssue(context, { title: "Track activity trail" });

      context.clock = fixedClock("2026-06-01T00:02:00.000Z");
      moveIssue(context, issue.identifier, "In Progress");

      context.clock = fixedClock("2026-06-01T00:03:00.000Z");
      updateIssue(context, issue.identifier, { title: "Track all activity writes" });

      context.clock = fixedClock("2026-06-01T00:04:00.000Z");
      assignIssue(context, issue.identifier, assignee.handle);

      context.clock = fixedClock("2026-06-01T00:05:00.000Z");
      const comment = addComment(context, {
        issue: issue.identifier,
        body: "Activity write covered."
      });

      context.clock = fixedClock("2026-06-01T00:06:00.000Z");
      attachLabel(context, issue.id, label.id);

      context.clock = fixedClock("2026-06-01T00:07:00.000Z");
      detachLabel(context, issue.id, label.id);

      context.clock = fixedClock("2026-06-01T00:08:00.000Z");
      updateIssue(context, issue.identifier, { parent: parent.identifier });

      context.clock = fixedClock("2026-06-01T00:09:00.000Z");
      updateIssue(context, issue.identifier, { parent: null });

      context.clock = fixedClock("2026-06-01T00:10:00.000Z");
      updateIssue(context, issue.identifier, { cycle: cycle.number });

      context.clock = fixedClock("2026-06-01T00:11:00.000Z");
      const attachment = addAttachment(context, {
        issue: issue.identifier,
        kind: "branch",
        repoPath: "/workspace/activity-app",
        branchName: "activity-trail"
      });

      context.clock = fixedClock("2026-06-01T00:12:00.000Z");
      archiveIssue(context, issue.identifier);

      const entries = listActivity(context, { issue: issue.identifier });
      const serialized = entries.map(serializeActivity);

      expect(entries).toHaveLength(12);
      expect(listActivity(context, { issue: issue.id }).map((entry) => entry.id)).toEqual(
        entries.map((entry) => entry.id)
      );
      expect(serialized.map((entry) => entry.action)).toEqual([
        "created",
        "state_changed",
        "updated",
        "assigned",
        "commented",
        "label_added",
        "label_removed",
        "updated",
        "updated",
        "updated",
        "linked",
        "archived"
      ]);
      expect(serialized.map((entry) => entry.createdAt)).toEqual([
        "2026-06-01T00:01:00.000Z",
        "2026-06-01T00:02:00.000Z",
        "2026-06-01T00:03:00.000Z",
        "2026-06-01T00:04:00.000Z",
        "2026-06-01T00:05:00.000Z",
        "2026-06-01T00:06:00.000Z",
        "2026-06-01T00:07:00.000Z",
        "2026-06-01T00:08:00.000Z",
        "2026-06-01T00:09:00.000Z",
        "2026-06-01T00:10:00.000Z",
        "2026-06-01T00:11:00.000Z",
        "2026-06-01T00:12:00.000Z"
      ]);
      expect(serialized).toMatchObject([
        { issueId: issue.id, actor: { handle: "owner" }, data: { identifier: issue.identifier } },
        { data: { fromName: "Todo", toName: "In Progress" } },
        { data: { changed: { title: "Track all activity writes" } } },
        {
          data: {
            from: null,
            to: assignee.id,
            fromHandle: null,
            toHandle: "build-agent"
          }
        },
        { data: { commentId: comment.id, parentId: null } },
        { data: { labelId: label.id, labelName: "Bug" } },
        { data: { labelId: label.id, labelName: "Bug" } },
        { data: { changed: { parentId: parent.id } } },
        { data: { changed: { parentId: null } } },
        { data: { changed: { cycleId: cycle.id } } },
        { data: { attachmentId: attachment.id, kind: "branch", repoPath: "/workspace/activity-app" } },
        { data: { identifier: issue.identifier } }
      ]);
      expect(Object.keys(serialized[0] ?? {})).toEqual([
        "id",
        "issueId",
        "actorId",
        "actor",
        "action",
        "data",
        "createdAt"
      ]);
      expect(JSON.stringify(serialized)).not.toContain("undefined");
    } finally {
      close();
    }
  });

  it("lists activity since a cursor across issues with stable cursors and filters", () => {
    const { context, close } = initializedContext("2026-06-02T00:00:00.000Z");

    try {
      const agent = createActor(context, {
        type: "agent",
        name: "Build Agent",
        handle: "build-agent"
      });
      createTeam(context, { key: "OPS", name: "Operations" });

      const first = createIssue(context, { title: "Prepare feed" });
      const second = createIssue(context, { title: "Route agent event" });
      const operations = createIssue(context, {
        team: "OPS",
        title: "Watch operations event"
      });

      assignIssue(context, second.identifier, agent.handle);
      moveIssue(context, first.identifier, "In Progress");

      const firstPage = listActivitySince(context, { cursor: "0", limit: 2 });

      expect(firstPage.events.map((event) => event.issueIdentifier)).toEqual([
        first.identifier,
        second.identifier
      ]);
      expect(firstPage.cursor).toBe(firstPage.events[1]?.cursor);
      expect(Number(firstPage.events[0]?.cursor)).toBeLessThan(
        Number(firstPage.events[1]?.cursor)
      );

      const nextPage = listActivitySince(context, { cursor: firstPage.cursor });
      expect(nextPage.events.map((event) => [event.issueIdentifier, event.action])).toEqual([
        [operations.identifier, "created"],
        [second.identifier, "assigned"],
        [first.identifier, "state_changed"]
      ]);
      expect(nextPage.cursor).toBe(nextPage.events.at(-1)?.cursor);

      expect(listActivitySince(context, { cursor: nextPage.cursor }).events).toEqual([]);
      expect(listActivitySince(context, { cursor: nextPage.cursor }).cursor).toBe(
        nextPage.cursor
      );
      expect(
        listActivitySince(context, { team: "ops" }).events.map((event) => event.issueIdentifier)
      ).toEqual([operations.identifier]);
      expect(
        listActivitySince(context, { assignee: agent.handle }).events.map((event) => [
          event.issueIdentifier,
          event.action
        ])
      ).toEqual([
        [second.identifier, "created"],
        [second.identifier, "assigned"]
      ]);

      expect(serializeActivityEvent(nextPage.events[0])).toMatchObject({
        cursor: nextPage.events[0]?.cursor,
        issueIdentifier: operations.identifier,
        issueId: operations.id,
        actor: { handle: "owner" },
        action: "created",
        data: { identifier: operations.identifier },
        createdAt: "2026-06-02T00:00:00.000Z"
      });
      expect(JSON.stringify(nextPage.events.map(serializeActivityEvent))).not.toContain(
        "undefined"
      );
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
        "attachments",
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
        attachments: [],
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

function recordTransactionOptions(db: Db): unknown[] {
  const options: unknown[] = [];
  const originalTransaction = db.transaction.bind(db) as (
    work: unknown,
    config?: unknown
  ) => unknown;

  db.transaction = ((work: unknown, config?: unknown) => {
    options.push(config);
    return originalTransaction(work, config);
  }) as typeof db.transaction;

  return options;
}

function expectIssueParentCycle(work: () => unknown): void {
  expectAppError(work, AppErrorCode.ISSUE_PARENT_CYCLE);
}

function expectAppError(work: () => unknown, code: string): void {
  let error: unknown;

  try {
    work();
  } catch (caught) {
    error = caught;
  }

  expect(error).toMatchObject({ code });
}
