import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";

import {
  addComment,
  applyMigrations,
  createActor,
  createIssue,
  init,
  moveIssue,
  openDb,
  type Clock,
  type Db,
  type ServiceContext
} from "@issue-tracker/core";

import { LinekeeperApp } from "../src/app.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("LinekeeperApp render", () => {
  it("renders the list, selected detail, activity strip, and agent attribution", async () => {
    const setup = initializedContext();

    try {
      const agent = createActor(setup.context, {
        type: "agent",
        name: "Claude Code",
        handle: "claude-code"
      });
      const first = createIssue(setup.context, {
        title: "Set up CI",
        description: "Run CI checks before packaging.",
        assignee: agent.handle,
        priority: 1
      });
      createIssue(setup.context, {
        title: "Add issue create",
        priority: 2
      });
      createIssue(setup.context, {
        title: "MCP list issues",
        priority: 3
      });

      setup.context.actor = agent;
      moveIssue(setup.context, first.identifier, "In Progress");
      addComment(setup.context, {
        issue: first.identifier,
        body: "Added vitest job."
      });

      const view = render(
        createElement(LinekeeperApp, {
          context: setup.context,
          dbPath: setup.dbPath,
          defaultTeam: "ENG"
        })
      );

      await tick();
      // Default view: the compact single-line issue list.
      const listFrame = stripAnsi(view.lastFrame() ?? "");

      expect(listFrame).toContain("Linekeeper");
      expect(listFrame).toContain("My Open");
      expect(listFrame).toContain("ENG-1");
      expect(listFrame).toContain("Set up CI");
      expect(listFrame).toContain("In Progress");
      expect(listFrame).toContain("Urgent");
      expect(listFrame).toContain("ENG-2");
      expect(listFrame).toContain("Add issue create");
      expect(listFrame).toContain("ENG-3");
      expect(listFrame).toContain("MCP list issues");

      // Enter opens the selected issue as a full-screen detail view.
      view.stdin.write("\r");
      await tick();
      const detailFrame = stripAnsi(view.lastFrame() ?? "");
      expect(detailFrame).toContain("ENG-1  Set up CI");
      expect(detailFrame).toContain("Project: none");
      expect(detailFrame).toContain("Assignee: @claude-code [agent]");
      expect(detailFrame).toContain("Description");
      expect(detailFrame).toContain("Run CI checks before packaging.");
      expect(detailFrame).toContain("Comments");
      expect(detailFrame).toContain("claude-code: Added vitest job.");

      // Expanding the activity strip reveals the full agent feed.
      view.stdin.write("A");
      await tick();
      const activityFrame = stripAnsi(view.lastFrame() ?? "");
      expect(activityFrame).toContain("ACTIVITY");
      expect(activityFrame).toContain("claude-code ENG-1 state_changed Todo -> In Progress");
      expect(activityFrame).toContain("claude-code ENG-1 commented");

      view.unmount();
    } finally {
      setup.close();
    }
  });

  it("shows an error status instead of crashing when a submitted view is missing", async () => {
    const setup = initializedContext();

    try {
      createIssue(setup.context, {
        title: "Keep current issue visible"
      });

      const view = render(
        createElement(LinekeeperApp, {
          context: setup.context,
          dbPath: setup.dbPath,
          defaultTeam: "ENG"
        })
      );

      await tick();
      view.stdin.write("v");
      await tick(25);
      view.stdin.write("Missing view");
      await tick(25);
      view.stdin.write("\r");
      await tick();
      await tick();

      const frame = stripAnsi(view.lastFrame() ?? "");

      expect(frame).toContain("Saved view Missing view was not found.");
      expect(frame).toContain("ENG-1");
      expect(frame).toContain("Keep current issue visible");

      view.unmount();
    } finally {
      setup.close();
    }
  });
});

function initializedContext(timestamp = "2026-07-01T00:00:00.000Z"): {
  context: ServiceContext;
  db: Db;
  dbPath: string;
  close: () => void;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-tui-render-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "tracker.db");
  const db = openDb(dbPath);
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
    dbPath,
    close: () => db.$client.close()
  };
}

function fixedClock(timestamp: string): Clock {
  return { now: () => new Date(timestamp) };
}

async function tick(delay = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}
