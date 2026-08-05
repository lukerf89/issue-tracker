import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement, isValidElement, type ReactElement } from "react";
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

import { highlightSnippet, LinekeeperApp } from "../src/app.js";

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
      expect(listFrame).toContain("Linekeeper | ENG | My Open | 3 issues");
      expect(listFrame).toContain("up/down move | enter open");
      expect(listFrame).toContain("My Open");
      expect(listFrame).toContain("ENG-1");
      expect(listFrame).toContain("> * ENG-1");
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
      expect(activityFrame).toContain("ACTIVITY (expanded - A to collapse)");
      expect(activityFrame).toContain("claude-code ENG-1 state_changed Todo -> In Progress");
      expect(activityFrame).toContain("claude-code ENG-1 commented");

      view.unmount();
    } finally {
      setup.close();
    }
  });

  it("renders a highlighted bm25 excerpt line under each search result", async () => {
    const setup = initializedContext();

    try {
      createIssue(setup.context, {
        title: "Paginate the backlog cursor",
        description: "Add cursor pagination to the backlog listing."
      });
      createIssue(setup.context, { title: "Unrelated docusign work" });

      const view = render(
        createElement(LinekeeperApp, {
          context: setup.context,
          dbPath: setup.dbPath,
          defaultTeam: "ENG"
        })
      );

      await tick();
      view.stdin.write("/");
      await tick(25);
      view.stdin.write("cursor");
      await tick(25);
      view.stdin.write("\r");
      await tick();
      await tick();

      const frame = stripAnsi(view.lastFrame() ?? "");
      // The matching issue is listed, and its excerpt renders as a second line:
      // the title text therefore appears twice (row + indented excerpt). The
      // renderer emits no ANSI in tests, so the highlight styling itself is
      // asserted at the logic level in the highlightSnippet unit test below.
      expect(frame).toContain("ENG-1");
      const occurrences = frame.split("Paginate the backlog cursor").length - 1;
      expect(occurrences).toBeGreaterThanOrEqual(2);
      expect(frame).not.toContain("Unrelated docusign work");

      view.unmount();
    } finally {
      setup.close();
    }
  });

  it("renders an active-filter chip bar and removes one chip by number", async () => {
    const setup = initializedContext();

    try {
      createActor(setup.context, { type: "agent", name: "Codex", handle: "codex" });
      createIssue(setup.context, { title: "Filterable work", assignee: "codex" });

      const view = render(
        createElement(LinekeeperApp, {
          context: setup.context,
          dbPath: setup.dbPath,
          defaultTeam: "ENG"
        })
      );

      await tick();
      view.stdin.write("f");
      await tick(25);
      view.stdin.write("state=Todo assignee=@codex");
      await tick(25);
      view.stdin.write("\r");
      await tick();
      await tick();

      const chipFrame = stripAnsi(view.lastFrame() ?? "");
      // Human-readable chips, numbered for removal.
      expect(chipFrame).toContain("[1] state=Todo");
      expect(chipFrame).toContain("[2] @codex");

      // Pressing the chip number peels off exactly that one filter.
      view.stdin.write("2");
      await tick();
      await tick();

      const afterFrame = stripAnsi(view.lastFrame() ?? "");
      // Exactly the assignee chip is peeled off; state chip remains as [1].
      // (@codex still appears in the issue's assignee column, so assert on the
      // chip number, not the bare handle.)
      expect(afterFrame).toContain("[1] state=Todo");
      expect(afterFrame).not.toContain("[2]");

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

  it("renders the expanded activity strip without activity", async () => {
    const setup = initializedContext();

    try {
      const view = render(
        createElement(LinekeeperApp, {
          context: setup.context,
          dbPath: setup.dbPath,
          defaultTeam: "ENG"
        })
      );

      await tick();
      view.stdin.write("A");
      await tick();

      const frame = stripAnsi(view.lastFrame() ?? "");
      expect(frame).toContain("ACTIVITY (expanded - A to collapse)");
      expect(frame).toContain("No activity yet.");

      view.unmount();
    } finally {
      setup.close();
    }
  });
});

describe("highlightSnippet", () => {
  const styledWords = (nodes: ReturnType<typeof highlightSnippet>): string[] =>
    (Array.isArray(nodes) ? nodes : [nodes])
      .filter((node): node is ReactElement<{ bold?: boolean; color?: string; children?: unknown }> =>
        isValidElement(node)
      )
      .filter((node) => node.props.bold === true && node.props.color === "cyan")
      .map((node) => String(node.props.children));

  it("emphasizes only the words that prefix-match a query token", () => {
    const styled = styledWords(highlightSnippet("Paginate the backlog cursor", ["cursor", "pag"]));
    // "cursor" (exact) and "Paginate" (prefix "pag") match; "the"/"backlog" do not.
    expect(styled).toContain("cursor");
    expect(styled).toContain("Paginate");
    expect(styled).not.toContain("the");
    expect(styled).not.toContain("backlog");
  });

  it("returns the plain string when there are no tokens", () => {
    expect(highlightSnippet("nothing to match", [])).toBe("nothing to match");
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
