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
  createSavedView,
  createTeam,
  createProject,
  createLabel,
  createCycle,
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
      expect(listFrame).toContain("Linekeeper | ENG | Issues | 3 loaded");
      expect(listFrame).toContain("up/down move | enter open");
      expect(listFrame).toContain("Issues");
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
      view.stdin.write("j");
      await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("claude-code: Added vitest job.");

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

  it("keeps the view during search and search during filter edits", async () => {
    const setup = initializedContext();
    try {
      createIssue(setup.context, { title: "Cursor urgent", priority: 1 });
      createIssue(setup.context, { title: "Cursor low", priority: 4 });
      createIssue(setup.context, { title: "Other urgent", priority: 1 });
      createSavedView(setup.context, { name: "Urgent", filters: { priority: 1 } });
      const view = render(createElement(LinekeeperApp, { context: setup.context, dbPath: setup.dbPath, defaultTeam: "ENG" }));
      for (const input of ["v", "Urgent", "\r", "/", "cursor", "\r", ":", "state=Todo", "\r"]) {
        await tick(); view.stdin.write(input);
      }
      await tick();
      const frame = stripAnsi(view.lastFrame() ?? "");
      expect(frame).toContain("Urgent (Modified)");
      expect(frame).toContain("/cursor");
      expect(frame).toContain("state=Todo");
      expect(frame).toContain("Cursor urgent");
      expect(frame).not.toContain("Cursor low");
      expect(frame).not.toContain("Other urgent");
      view.stdin.write("1"); await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("/cursor");
      view.unmount();
    } finally { setup.close(); }
  });

  it("says so when clearing the view also drops the team scope", async () => {
    const setup = initializedContext();
    try {
      createIssue(setup.context, { title: "Cursor task" });
      const view = render(createElement(LinekeeperApp, { context: setup.context, dbPath: setup.dbPath, defaultTeam: "ENG" }));
      for (const input of ["v", "\r"]) { await tick(); view.stdin.write(input); }
      await tick();
      const frame = stripAnsi(view.lastFrame() ?? "");
      // Clearing the view unscopes the query entirely, default team included;
      // the status line has to admit that, not just say the view is gone.
      expect(frame).toContain("| all teams |");
      expect(frame).toContain("View cleared; search, filters and team scope reset.");
      view.unmount();
    } finally { setup.close(); }
  });

  it("treats team=all as a whole token rather than a substring", async () => {
    const setup = initializedContext();
    try {
      createIssue(setup.context, { title: "Cursor task" });
      const view = render(createElement(LinekeeperApp, { context: setup.context, dbPath: setup.dbPath, defaultTeam: "ENG" }));
      await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("| ENG |");
      // A label whose value happens to spell team=all is an ordinary filter and
      // must not widen the scope to every team.
      for (const input of [":", "label=team=all", "\r"]) { await tick(); view.stdin.write(input); }
      await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("| ENG |");
      for (const input of [":", "team=all", "\r"]) { await tick(); view.stdin.write(input); }
      await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("| all teams |");
      view.unmount();
    } finally { setup.close(); }
  });

  it("loads beyond 100 on navigation, goes backward, and resets for a new query", async () => {
    const setup = initializedContext();
    try {
      for (let i = 0; i < 105; i++) createIssue(setup.context, { title: `Cursor task ${i}` });
      const view = render(createElement(LinekeeperApp, { context: setup.context, dbPath: setup.dbPath }));
      await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("100 loaded · more available");
      view.stdin.write("G"); await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("105 loaded · end of results");
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("ENG-105");
      view.stdin.write("k"); await tick();
      view.stdin.write("\r"); await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("ENG-104  Cursor task 103");
      view.stdin.write("\u001b"); await tick();
      for (const input of ["/", "absent", "\r"]) { view.stdin.write(input); await tick(); }
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("0 loaded · end of results");
      view.unmount();
    } finally { setup.close(); }
  });

  it("keeps the selection when a new row pushes it past the loaded depth", async () => {
    const setup = initializedContext();
    try {
      createTeam(setup.context, { key: "OPS", name: "Operations" });
      for (let i = 0; i < 99; i++) createIssue(setup.context, { title: `Eng task ${i}` });
      createIssue(setup.context, { title: "Ops task 0", team: "OPS" });
      const view = render(createElement(LinekeeperApp, { context: setup.context, dbPath: setup.dbPath }));
      await tick();
      // Lists sort by team key, so the single OPS row is last — at index 99 of
      // the 100 loaded.
      view.stdin.write("G"); await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("100 loaded");
      // A new ENG issue sorts ahead of it, shifting it to index 100: one past
      // the depth that was loaded, but still in the query.
      for (const input of ["n", "Eng newcomer", "\r"]) { await tick(); view.stdin.write(input); }
      await tick();
      view.stdin.write("\r"); await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("OPS-1  Ops task 0");
      view.unmount();
    } finally { setup.close(); }
  });

  it("re-pages only to the depth already loaded when a refresh drops the selected issue", async () => {
    const setup = initializedContext();
    try {
      for (let i = 0; i < 205; i++) createIssue(setup.context, { title: `Cursor task ${i}` });
      createSavedView(setup.context, { name: "Todo queue", filters: { state: "Todo" } });
      const view = render(createElement(LinekeeperApp, { context: setup.context, dbPath: setup.dbPath }));
      for (const input of ["v", "Todo queue", "\r"]) { await tick(); view.stdin.write(input); }
      await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("100 loaded · more available");
      // Moving the selection out of the view refreshes from page one. The row is
      // gone for good, so the reload stops one page past the depth already on
      // screen instead of walking every remaining page hunting for it.
      for (const input of ["m", "Done", "\r"]) { await tick(); view.stdin.write(input); }
      await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("200 loaded · more available");
      view.unmount();
    } finally { setup.close(); }
  });

  it.each([
    ["Status", "In Progress", "state=In Progress"],
    ["Assignee", "Unassigned", "unassigned"],
    ["Assignee", "Me", "@human"],
    ["Project", "No project", "no-project"],
    ["Project", "Test Project", "project:Test Project"],
    ["Label", "Test Label", "label:Test Label"],
    ["Priority", "Urgent", "priority:Urgent"],
    ["Cycle", "Test Cycle", "cycle:Test Cycle"],
    ["Team", "All teams", "all teams"],
  ])("picks %s / %s and preserves search", async (field, value, expected) => {
    const setup = initializedContext();
    try {
      createProject(setup.context, { name: "Test Project" });
      createLabel(setup.context, { name: "Test Label" });
      createCycle(setup.context, { name: "Test Cycle" });
      createIssue(setup.context, { title: "Cursor work" });
      const view = render(createElement(LinekeeperApp, { context: setup.context, dbPath: setup.dbPath, defaultTeam: "ENG" }));
      for (const input of ["/", "cursor", "\r", "f", field, "\r", value, "\r"]) {
        await tick(); view.stdin.write(input);
      }
      await tick();
      const frame = stripAnsi(view.lastFrame() ?? "");
      expect(frame).toContain(expected === "@human" ? `@${setup.context.actor!.handle}` : expected);
      expect(frame).toContain("/cursor");
      expect(frame).not.toContain("type to search");
      view.unmount();
    } finally { setup.close(); }
  });

  it("cancels picker edits and supports arrow selection", async () => {
    const setup = initializedContext();
    try {
      createIssue(setup.context, { title: "Unchanged task" });
      const view = render(createElement(LinekeeperApp, { context: setup.context, dbPath: setup.dbPath }));
      for (const input of ["f", "Priority", "\r", "Urgent", "\u001b"]) { await tick(); view.stdin.write(input); }
      await tick();
      await tick(100);
      expect(stripAnsi(view.lastFrame() ?? "")).not.toContain("type to search");
      expect(stripAnsi(view.lastFrame() ?? "")).not.toContain("priority:Urgent");
      for (const input of ["f", "Priority", "\r", "\u001b[B", "\r"]) { await tick(); view.stdin.write(input); }
      await tick();
      expect(stripAnsi(view.lastFrame() ?? "")).toContain("priority:No priority");
      view.unmount();
    } finally { setup.close(); }
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
      view.stdin.write(":");
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
      expect(afterFrame).not.toContain("[2] @codex");

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
