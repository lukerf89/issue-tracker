import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
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
  getIssue,
  init,
  listActivity,
  listStates,
  moveIssue,
  openDb,
  whoami,
  type Clock,
  type ServiceContext
} from "@issue-tracker/core";

import IssueDetailPage from "../app/issues/[identifier]/page";
import {
  addIssueCommentAction,
  assignIssueDetailAction,
  moveIssueDetailAction,
  updateIssueDetailFieldsAction,
  updateIssueLabelAction
} from "../src/data/actions";

const tempDirs: string[] = [];
const originalIssueTrackerDb = process.env.ISSUE_TRACKER_DB;

afterEach(() => {
  cleanup();

  if (originalIssueTrackerDb === undefined) {
    delete process.env.ISSUE_TRACKER_DB;
  } else {
    process.env.ISSUE_TRACKER_DB = originalIssueTrackerDb;
  }

  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("issue detail page", () => {
  it("renders the full core-backed issue graph", async () => {
    const seeded = seedIssueDetailDb();
    process.env.ISSUE_TRACKER_DB = seeded.dbPath;

    render(await IssueDetailPage({ params: Promise.resolve({ identifier: seeded.identifier }) }));

    expect(screen.getByRole("heading", { level: 1, name: "Render issue detail" })).toBeInTheDocument();
    expect(screen.getByText("markdown detail", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getAllByText("In Progress").length).toBeGreaterThan(0);
    expect(screen.getAllByText("P1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("detail-agent").length).toBeGreaterThan(0);
    expect(screen.getByText("Issue Detail Polish")).toBeInTheDocument();
    expect(screen.getByText("#8 Detail Cycle")).toBeInTheDocument();

    const relations = screen.getByRole("region", { name: "Parent and sub-issues" });
    expect(
      within(relations).getByRole("link", { name: "ENG-1 Track web milestone" })
    ).toHaveAttribute("href", "/issues/ENG-1");
    expect(
      within(relations).getByRole("link", { name: "ENG-3 Wire detail child issue" })
    ).toHaveAttribute("href", "/issues/ENG-3");

    expect(within(screen.getByLabelText("Current labels")).getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("Spec link")).toBeInTheDocument();
    expect(screen.getByText("Feature branch")).toBeInTheDocument();
    expect(screen.getByText("Review PR")).toBeInTheDocument();
    expect(screen.getByText("Fix commit")).toBeInTheDocument();
    expect(screen.getByText("comment", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("detail-agent", { selector: "code" })).toBeInTheDocument();

    const activity = screen.getByRole("region", { name: "Activity" });
    expect(within(activity).getByText("created")).toBeInTheDocument();
    expect(within(activity).getByText("label added")).toBeInTheDocument();
    expect(within(activity).getByText("state changed")).toBeInTheDocument();
    expect(within(activity).getAllByText("linked").length).toBe(4);
    expect(within(activity).getAllByText("commented").length).toBe(2);
  });

  it("persists inline mutations through server actions and records activity", async () => {
    const seeded = seedIssueDetailDb();
    process.env.ISSUE_TRACKER_DB = seeded.dbPath;

    await updateIssueDetailFieldsAction(
      formData({
        identifier: seeded.identifier,
        title: "Render editable issue detail",
        description: "Updated **copy** from the detail page.",
        priority: "2"
      })
    );
    await moveIssueDetailAction(
      formData({
        identifier: seeded.identifier,
        state: seeded.doneStateId
      })
    );
    await assignIssueDetailAction(
      formData({
        identifier: seeded.identifier,
        actor: "--me"
      })
    );
    await assignIssueDetailAction(
      formData({
        identifier: seeded.identifier,
        actor: "detail-agent"
      })
    );
    await assignIssueDetailAction(
      formData({
        identifier: seeded.identifier,
        actor: "--none"
      })
    );
    await addIssueCommentAction(
      formData({
        identifier: seeded.identifier,
        body: "Mutation **comment** from the action.",
        parent: ""
      })
    );
    await updateIssueLabelAction(
      formData({
        identifier: seeded.identifier,
        labelId: seeded.frontendLabelId,
        operation: "remove"
      })
    );
    await updateIssueLabelAction(
      formData({
        identifier: seeded.identifier,
        labelId: seeded.bugLabelId,
        operation: "add"
      })
    );

    const persisted = readIssueDetail(seeded.dbPath, seeded.identifier);

    expect(persisted.issue).toMatchObject({
      title: "Render editable issue detail",
      description: "Updated **copy** from the detail page.",
      priority: 2,
      stateId: seeded.doneStateId,
      assigneeId: null
    });
    expect(persisted.issue.labels.map((label) => label.name)).toEqual(["Bug"]);
    expect(persisted.issue.comments.map((comment) => comment.body)).toContain(
      "Mutation **comment** from the action."
    );
    expect(persisted.activity.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "updated",
        "state_changed",
        "assigned",
        "commented",
        "label_removed",
        "label_added"
      ])
    );
    expect(persisted.activity.filter((entry) => entry.action === "assigned")).toHaveLength(3);

    render(await IssueDetailPage({ params: Promise.resolve({ identifier: seeded.identifier }) }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Render editable issue detail" })
    ).toBeInTheDocument();
    expect(screen.getByText("copy", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
    expect(screen.getAllByText("P2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);
    expect(within(screen.getByLabelText("Current labels")).getByText("Bug")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Current labels")).queryByText("Frontend")).toBeNull();
    expect(screen.getAllByText("comment", { selector: "strong" }).length).toBeGreaterThan(0);
  });
});

interface SeededIssueDetailDb {
  dbPath: string;
  identifier: string;
  doneStateId: string;
  frontendLabelId: string;
  bugLabelId: string;
}

function seedIssueDetailDb(): SeededIssueDetailDb {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-web-detail-"));
  tempDirs.push(tempDir);

  const dbPath = join(tempDir, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);

  try {
    const context: ServiceContext = {
      db,
      actor: null,
      clock: fixedClock("2026-05-01T09:00:00.000Z")
    };
    const { team } = init(context, {
      teamKey: "ENG",
      teamName: "Engineering",
      actorHandle: "owner",
      actorName: "Human Owner"
    });
    context.actor = whoami(context);

    const agent = createActor(context, {
      type: "agent",
      name: "Detail Agent",
      handle: "detail-agent"
    });
    const project = createProject(context, {
      name: "Issue Detail Polish",
      description: "Ship the web issue detail view.",
      status: "started"
    });
    const cycle = createCycle(context, {
      team: "ENG",
      number: 8,
      name: "Detail Cycle",
      startsAt: "2026-05-01T00:00:00.000Z",
      endsAt: "2026-05-15T00:00:00.000Z"
    });
    const frontend = createLabel(context, {
      name: "Frontend",
      color: "#14B8A6",
      group: "Area"
    });
    const bug = createLabel(context, {
      name: "Bug",
      color: "#EF4444",
      group: "Type"
    });

    const parent = createIssue(context, {
      title: "Track web milestone"
    });
    const issue = createIssue(context, {
      title: "Render issue detail",
      description: "Ship **markdown detail** with a [spec link](https://example.test/spec).",
      assignee: agent.handle,
      projectId: project.id,
      cycle: cycle.number,
      priority: 1,
      parent: parent.identifier,
      labels: [frontend.id]
    });
    createIssue(context, {
      title: "Wire detail child issue",
      parent: issue.identifier
    });

    moveIssue(context, issue.identifier, "In Progress");
    addAttachment(context, {
      issue: issue.identifier,
      kind: "link",
      title: "Spec link",
      url: "https://example.test/spec"
    });
    addAttachment(context, {
      issue: issue.identifier,
      kind: "branch",
      title: "Feature branch",
      repoPath: "/tmp/example",
      branchName: "feature/detail-view"
    });
    addAttachment(context, {
      issue: issue.identifier,
      kind: "pr",
      title: "Review PR",
      repoPath: "/tmp/example",
      url: "https://example.test/pull/12"
    });
    addAttachment(context, {
      issue: issue.identifier,
      kind: "commit",
      title: "Fix commit",
      repoPath: "/tmp/example",
      commitSha: "abc1234"
    });

    const rootComment = addComment(context, {
      issue: issue.identifier,
      body: "Root **comment** from owner."
    });
    context.actor = agent;
    addComment(context, {
      issue: issue.identifier,
      body: "Nested reply from `detail-agent`.",
      parent: rootComment.id
    });

    const doneState = listStates(context, team.id).find((state) => state.name === "Done");
    if (!doneState) {
      throw new Error("Seeded Done state was not found.");
    }

    return {
      dbPath,
      identifier: issue.identifier,
      doneStateId: doneState.id,
      frontendLabelId: frontend.id,
      bugLabelId: bug.id
    };
  } finally {
    db.$client.close();
  }
}

function readIssueDetail(dbPath: string, identifier: string) {
  const db = openDb(dbPath);

  try {
    const context: ServiceContext = {
      db,
      actor: null,
      clock: fixedClock("2026-05-01T10:00:00.000Z")
    };

    return {
      issue: getIssue(context, identifier),
      activity: listActivity(context, { issue: identifier })
    };
  } finally {
    db.$client.close();
  }
}

function formData(values: Record<string, string>): FormData {
  const data = new FormData();

  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }

  return data;
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}
