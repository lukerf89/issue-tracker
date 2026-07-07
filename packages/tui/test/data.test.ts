import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createActor,
  createIssue,
  createLabel,
  init,
  listActivitySince,
  openDb,
  type Clock,
  type Db,
  type ServiceContext
} from "@issue-tracker/core";

import {
  commandFromMode,
  executeLinekeeperCommand,
  loadLinekeeperData,
  parseFilterInput
} from "../src/data.js";
import { formatLastAgentActivity, issueAssignee, issueState } from "../src/format.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Linekeeper core-facing handlers", () => {
  it("loads list/detail/activity data through core services", () => {
    const setup = initializedContext();

    try {
      const agent = createActor(setup.context, {
        type: "agent",
        name: "Build Agent",
        handle: "build-agent"
      });
      const issue = createIssue(setup.context, {
        title: "Route agent work",
        assignee: agent.handle,
        priority: 1
      });

      setup.context.actor = agent;
      executeLinekeeperCommand(setup.context, {
        kind: "move",
        issueIdentifier: issue.identifier,
        state: "In Progress"
      });

      const data = loadLinekeeperData(setup.context, { team: "ENG" });
      const listed = data.issues[0];

      expect(listed?.identifier).toBe("ENG-1");
      expect(issueState(data, listed!)?.name).toBe("In Progress");
      expect(issueAssignee(data, listed!)?.handle).toBe("build-agent");
      expect(formatLastAgentActivity(data, listed!)).toBe(
        "agent: state_changed Todo -> In Progress"
      );
    } finally {
      setup.close();
    }
  });

  it("turns command modes into core mutations for move, assign, comment, labels, and sub-issues", () => {
    const setup = initializedContext();

    try {
      const agent = createActor(setup.context, {
        type: "agent",
        name: "Codex",
        handle: "codex"
      });
      createLabel(setup.context, { name: "Bug", color: "#EF4444" });
      const issue = createIssue(setup.context, { title: "Review agent notes" });

      executeLinekeeperCommand(
        setup.context,
        commandFromMode({ kind: "move", input: "In Progress" }, issue, "ENG")
      );
      executeLinekeeperCommand(
        setup.context,
        commandFromMode({ kind: "assign", input: "@codex" }, issue, "ENG")
      );
      executeLinekeeperCommand(
        setup.context,
        commandFromMode({ kind: "labels", input: "Bug" }, issue, "ENG")
      );
      executeLinekeeperCommand(
        setup.context,
        commandFromMode({ kind: "comment", input: "Leaving a fictional note." }, issue, "ENG")
      );
      const childResult = executeLinekeeperCommand(
        setup.context,
        commandFromMode({ kind: "subIssue", input: "Add regression test" }, issue, "ENG")
      );

      const data = loadLinekeeperData(setup.context, { team: "ENG" });
      const parent = data.issues.find((candidate) => candidate.identifier === issue.identifier);
      const child = data.issues.find((candidate) => candidate.identifier === childResult.issueIdentifier);

      expect(parent?.labels.map((label) => label.name)).toEqual(["Bug"]);
      expect(parent?.comments.map((comment) => comment.body)).toEqual([
        "Leaving a fictional note."
      ]);
      expect(issueState(data, parent!)?.name).toBe("In Progress");
      expect(issueAssignee(data, parent!)?.id).toBe(agent.id);
      expect(parent?.children.map((reference) => reference.identifier)).toEqual([
        child?.identifier
      ]);
      expect(child?.parent?.identifier).toBe(parent?.identifier);
    } finally {
      setup.close();
    }
  });

  it("parses read filters and branch/link commands into core-shaped inputs", () => {
    const filters = parseFilterInput("state=Todo assignee=@codex priority=1 archived");

    expect(filters).toEqual({
      state: "Todo",
      assignee: "codex",
      priority: 1,
      includeArchived: true
    });

    const setup = initializedContext();

    try {
      const issue = createIssue(setup.context, { title: "Trace branch links" });
      executeLinekeeperCommand(
        setup.context,
        commandFromMode(
          { kind: "link", input: "branch /tmp/fictional feat/eng-1-ci" },
          issue,
          "ENG"
        )
      );

      expect(
        listActivitySince(setup.context).events.map((event) => [
          event.issueIdentifier,
          event.action,
          event.data
        ])
      ).toEqual([
        [issue.identifier, "created", { identifier: issue.identifier }],
        [
          issue.identifier,
          "linked",
          expect.objectContaining({
            kind: "branch",
            branchName: "feat/eng-1-ci",
            repoPath: "/tmp/fictional"
          })
        ]
      ]);
    } finally {
      setup.close();
    }
  });
});

function initializedContext(timestamp = "2026-07-01T00:00:00.000Z"): {
  context: ServiceContext;
  db: Db;
  close: () => void;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-tui-"));
  tempDirs.push(tempDir);
  const db = openDb(join(tempDir, "tracker.db"));
  applyMigrations(db);
  const context: ServiceContext = {
    db,
    actor: null,
    clock: fixedClock(timestamp)
  };
  const initialized = init(context);
  context.actor = initialized.actor;

  return {
    context,
    db,
    close: () => db.$client.close()
  };
}

function fixedClock(timestamp: string): Clock {
  return { now: () => new Date(timestamp) };
}
