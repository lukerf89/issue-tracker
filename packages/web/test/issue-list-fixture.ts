import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMigrations,
  archiveIssue,
  createActor,
  createCycle,
  createIssue,
  createLabel,
  createProject,
  init,
  moveIssue,
  openDb,
  whoami,
  type Clock,
  type ServiceContext
} from "@issue-tracker/core";

export interface SeededIssueListDb {
  dbPath: string;
  projectId: string;
  cycleNumber: number;
}

export function seedFilteredIssueListDb(tempDirs: string[]): SeededIssueListDb {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-web-list-"));
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
    const otherProject = createProject(context, {
      name: "Docs Platform",
      status: "planned"
    });
    const assignee = createActor(context, {
      type: "agent",
      name: "Build Agent",
      handle: "build-agent"
    });

    createLabel(context, {
      name: "Frontend",
      color: "#14B8A6",
      group: "Area"
    });
    createLabel(context, {
      name: "Docs",
      color: "#22C55E",
      group: "Area"
    });

    const cycle = createCycle(context, {
      team: "ENG",
      number: 1,
      name: "Cycle 1",
      startsAt: "2026-03-01T00:00:00.000Z",
      endsAt: "2026-03-15T00:00:00.000Z"
    });
    const nextCycle = createCycle(context, {
      team: "ENG",
      number: 2,
      name: "Cycle 2",
      startsAt: "2026-03-16T00:00:00.000Z",
      endsAt: "2026-03-30T00:00:00.000Z"
    });

    const matching = createIssue(context, {
      title: "Implement filtered issue list",
      assignee: assignee.handle,
      projectId: project.id,
      cycle: cycle.number,
      priority: 1,
      labels: ["Frontend"]
    });
    createIssue(context, {
      title: "Keep backlog issue visible",
      assignee: assignee.handle,
      projectId: project.id,
      cycle: cycle.number,
      priority: 1,
      labels: ["Frontend"]
    });
    const wrongAssignee = createIssue(context, {
      title: "Unassigned frontend task",
      projectId: project.id,
      cycle: cycle.number,
      priority: 1,
      labels: ["Frontend"]
    });
    const wrongProject = createIssue(context, {
      title: "Document list filters",
      assignee: assignee.handle,
      projectId: otherProject.id,
      cycle: cycle.number,
      priority: 1,
      labels: ["Frontend"]
    });
    const wrongLabel = createIssue(context, {
      title: "Render docs label",
      assignee: assignee.handle,
      projectId: project.id,
      cycle: cycle.number,
      priority: 1,
      labels: ["Docs"]
    });
    const wrongPriority = createIssue(context, {
      title: "Tune filter density",
      assignee: assignee.handle,
      projectId: project.id,
      cycle: cycle.number,
      priority: 2,
      labels: ["Frontend"]
    });
    const wrongCycle = createIssue(context, {
      title: "Plan next cycle",
      assignee: assignee.handle,
      projectId: project.id,
      cycle: nextCycle.number,
      priority: 1,
      labels: ["Frontend"]
    });
    const archived = createIssue(context, {
      title: "Archived filtered list cleanup",
      assignee: assignee.handle,
      projectId: project.id,
      cycle: cycle.number,
      priority: 1,
      labels: ["Frontend"]
    });

    for (const issue of [
      matching,
      wrongAssignee,
      wrongProject,
      wrongLabel,
      wrongPriority,
      wrongCycle,
      archived
    ]) {
      moveIssue(context, issue.identifier, "In Progress");
    }

    archiveIssue(context, archived.identifier);

    return {
      dbPath,
      projectId: project.id,
      cycleNumber: cycle.number
    };
  } finally {
    db.$client.close();
  }
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}
