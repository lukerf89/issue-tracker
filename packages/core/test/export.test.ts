import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addComment,
  applyMigrations,
  createActor,
  createCycle,
  createIssue,
  createLabel,
  createProject,
  createSavedView,
  createTeam,
  exportSnapshot,
  init,
  openDb,
  uuid,
  whoami,
  type Clock,
  type ServiceContext
} from "../src/index.js";
import { attachments, milestones } from "../src/db/schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("exportSnapshot", () => {
  it("exports a deterministic portable snapshot covering every entity type", () => {
    const { context, db, close } = initializedContext("2026-05-01T00:00:00.000Z");

    try {
      createTeam(context, { key: "OPS", name: "Operations" });
      const agent = createActor(context, {
        type: "agent",
        name: "Build Agent",
        handle: "build-agent"
      });
      const project = createProject(context, {
        name: "Platform Foundations",
        description: "Fictional migration project.",
        status: "planned",
        leadId: agent.id,
        startDate: "2026-05-01",
        targetDate: "2026-06-01"
      });
      const milestone = {
        id: uuid(),
        projectId: project.id,
        name: "Snapshot Ready",
        targetDate: "2026-05-15",
        position: 1
      };

      db.insert(milestones).values(milestone).run();

      context.clock = fixedClock("2026-05-01T00:01:00.000Z");
      const cycle = createCycle(context, {
        team: "ENG",
        name: "Cycle 1",
        startsAt: "2026-05-01T00:00:00.000Z",
        endsAt: "2026-05-15T00:00:00.000Z"
      });
      const label = createLabel(context, {
        name: "Migration",
        color: "#22C55E",
        group: "Type"
      });

      context.clock = fixedClock("2026-05-01T00:02:00.000Z");
      const issue = createIssue(context, {
        title: "Export fictional workspace",
        description: "Make snapshot data portable.",
        assignee: agent.handle,
        project: project.name,
        cycle: cycle.number,
        priority: 2,
        labels: [label.name],
        estimate: 3,
        dueDate: "2026-05-10"
      });

      context.clock = fixedClock("2026-05-01T00:03:00.000Z");
      const comment = addComment(context, {
        issue: issue.identifier,
        body: "Snapshot includes comments."
      });
      const attachment = {
        id: uuid(),
        issueId: issue.id,
        kind: "link" as const,
        title: "Design note",
        url: "https://example.invalid/export-note",
        repoPath: null,
        remote: null,
        branchName: null,
        commitSha: null,
        createdAt: "2026-05-01T00:04:00.000Z"
      };

      db.insert(attachments).values(attachment).run();

      context.clock = fixedClock("2026-05-01T00:05:00.000Z");
      const savedView = createSavedView(context, {
        name: "Migration bugs",
        filters: { label: label.name, priority: 2 },
        description: null
      });

      const snapshot = exportSnapshot(context);

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
        "comments",
        "actors",
        "attachments",
        "activity",
        "savedViews"
      ]);
      expect(snapshot.workspace).toMatchObject({
        name: "Local Workspace",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z"
      });
      expect(snapshot.config.map((entry) => entry.key)).toEqual([
        "default_actor",
        "default_team"
      ]);
      expect(snapshot.teams.map((team) => team.key)).toEqual(["ENG", "OPS"]);
      expect(snapshot.workflowStates).toHaveLength(10);
      expect(snapshot.workflowStates.map((state) => [state.teamId, state.name])).toContainEqual([
        issue.teamId,
        "Todo"
      ]);
      expect(snapshot.projects).toMatchObject([
        {
          id: project.id,
          name: "Platform Foundations",
          description: "Fictional migration project.",
          leadId: agent.id
        }
      ]);
      expect(snapshot.milestones).toEqual([
        {
          id: milestone.id,
          projectId: project.id,
          name: "Snapshot Ready",
          targetDate: "2026-05-15",
          position: 1
        }
      ]);
      expect(snapshot.cycles).toMatchObject([
        {
          id: cycle.id,
          number: 1,
          name: "Cycle 1",
          startsAt: "2026-05-01T00:00:00.000Z",
          endsAt: "2026-05-15T00:00:00.000Z"
        }
      ]);
      expect(snapshot.issues).toMatchObject([
        {
          id: issue.id,
          identifier: "ENG-1",
          title: "Export fictional workspace",
          description: "Make snapshot data portable.",
          assigneeId: agent.id,
          projectId: project.id,
          cycleId: cycle.id,
          parentId: null,
          estimate: 3,
          dueDate: "2026-05-10",
          createdAt: "2026-05-01T00:02:00.000Z"
        }
      ]);
      expect(snapshot.labels).toMatchObject([
        {
          id: label.id,
          name: "Migration",
          group: "Type",
          archivedAt: null
        }
      ]);
      expect(snapshot.issueLabels).toEqual([{ issueId: issue.id, labelId: label.id }]);
      expect(snapshot.comments).toEqual([
        {
          id: comment.id,
          issueId: issue.id,
          authorId: context.actor?.id,
          body: "Snapshot includes comments.",
          parentId: null,
          createdAt: "2026-05-01T00:03:00.000Z"
        }
      ]);
      expect(snapshot.actors.map((actor) => actor.handle)).toEqual(["build-agent", "owner"]);
      expect(snapshot.attachments).toEqual([
        {
          id: attachment.id,
          issueId: issue.id,
          kind: "link",
          title: "Design note",
          url: "https://example.invalid/export-note",
          repoPath: null,
          remote: null,
          branchName: null,
          commitSha: null,
          createdAt: "2026-05-01T00:04:00.000Z"
        }
      ]);
      expect(snapshot.activity.map((entry) => entry.action)).toEqual([
        "created",
        "label_added",
        "commented"
      ]);
      expect(snapshot.activity).toMatchObject([
        { issueId: issue.id, actorId: context.actor?.id, data: { identifier: "ENG-1" } },
        { issueId: issue.id, data: { labelId: label.id, labelName: "Migration" } },
        { issueId: issue.id, data: { commentId: comment.id, parentId: null } }
      ]);
      expect(snapshot.savedViews).toEqual([
        {
          id: savedView.id,
          name: "Migration bugs",
          filters: { label: "Migration", priority: 2 },
          description: null,
          createdAt: "2026-05-01T00:05:00.000Z",
          updatedAt: "2026-05-01T00:05:00.000Z"
        }
      ]);
      expect(JSON.stringify(snapshot)).not.toContain("undefined");
    } finally {
      close();
    }
  });
});

function initializedContext(now: string) {
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
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-export-"));
  tempDirs.push(tempDir);

  return openDb(join(tempDir, "tracker.db"));
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}
