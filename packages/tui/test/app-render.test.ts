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
      const frame = stripAnsi(view.lastFrame() ?? "");

      expect(frame).toContain("Linekeeper - ENG issues");
      expect(frame).toContain("VIEW: My Open");
      expect(frame).toContain("ENG-1 Set up CI");
      expect(frame).toContain("In Progress  Urgent");
      expect(frame).toContain("ENG-2 Add issue create");
      expect(frame).toContain("Todo  High");
      expect(frame).toContain("ENG-3 MCP list issues");
      expect(frame).toContain("ENG-1  Set up CI");
      expect(frame).toContain("Project: none");
      expect(frame).toContain("Assignee: @claude-code [agent]");
      expect(frame).toContain("Description");
      expect(frame).toContain("Run CI checks before packaging.");
      expect(frame).toContain("Comments");
      expect(frame).toContain("claude-code: Added vitest job.");
      expect(frame).toContain("ACTIVITY");
      expect(frame).toContain("claude-code ENG-1 state_changed Todo -> In Progress");
      expect(frame).toContain("claude-code ENG-1 commented");

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

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}
