import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createActor,
  createIssue,
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

import BoardPage from "../app/board/page";
import { moveBoardIssueAction } from "../src/data/actions";

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

describe("board page", () => {
  it("groups issues by workflow state and moves a card through the board action", async () => {
    const seeded = seedBoardDb();
    process.env.ISSUE_TRACKER_DB = seeded.dbPath;

    render(await BoardPage());

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "Done",
      "Canceled"
    ]);

    const todoColumn = screen.getByRole("region", { name: "Todo" });
    const startedColumn = screen.getByRole("region", { name: "In Progress" });

    const todoCard = within(todoColumn).getByRole("article", {
      name: "ENG-1 Design board move menu"
    });
    expect(within(todoCard).getByText("P2")).toBeInTheDocument();
    expect(within(todoCard).getByText("board-agent")).toBeInTheDocument();
    expect(
      within(todoCard).getByRole("combobox", { name: "Move ENG-1 to state" })
    ).toBeInTheDocument();
    expect(
      within(startedColumn).getByRole("article", { name: "ENG-2 Render active board cards" })
    ).toBeInTheDocument();
    expect(
      within(startedColumn).queryByRole("article", { name: "ENG-1 Design board move menu" })
    ).not.toBeInTheDocument();

    const formData = new FormData();
    formData.set("identifier", "ENG-1");
    formData.set("state", seeded.inProgressStateId);

    await moveBoardIssueAction(formData);

    cleanup();
    render(await BoardPage());

    expect(
      within(screen.getByRole("region", { name: "Todo" })).queryByRole("article", {
        name: "ENG-1 Design board move menu"
      })
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "In Progress" })).getByRole("article", {
        name: "ENG-1 Design board move menu"
      })
    ).toBeInTheDocument();

    const persisted = readIssueAndActivity(seeded.dbPath, "ENG-1");
    expect(persisted.stateId).toBe(seeded.inProgressStateId);
    expect(persisted.activity).toContainEqual(
      expect.objectContaining({
        action: "state_changed",
        data: expect.objectContaining({
          fromName: "Todo",
          toName: "In Progress"
        })
      })
    );
  });
});

function seedBoardDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-web-board-"));
  tempDirs.push(tempDir);

  const dbPath = join(tempDir, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);

  try {
    const context: ServiceContext = {
      db,
      actor: null,
      clock: fixedClock("2026-04-01T09:00:00.000Z")
    };
    const { team } = init(context, {
      teamKey: "ENG",
      teamName: "Engineering",
      actorHandle: "owner",
      actorName: "Human Owner"
    });
    context.actor = whoami(context);

    const assignee = createActor(context, {
      type: "agent",
      name: "Board Agent",
      handle: "board-agent"
    });
    createIssue(context, {
      title: "Design board move menu",
      assignee: assignee.handle,
      priority: 2
    });
    const activeIssue = createIssue(context, {
      title: "Render active board cards",
      priority: 1
    });
    const doneIssue = createIssue(context, {
      title: "Ship completed board card",
      priority: 4
    });

    moveIssue(context, activeIssue.identifier, "In Progress");
    moveIssue(context, doneIssue.identifier, "Done");

    const inProgressState = listStates(context, team.id).find(
      (state) => state.name === "In Progress"
    );
    if (!inProgressState) {
      throw new Error("Seeded In Progress state was not found.");
    }

    return {
      dbPath,
      inProgressStateId: inProgressState.id
    };
  } finally {
    db.$client.close();
  }
}

function readIssueAndActivity(dbPath: string, identifier: string) {
  const db = openDb(dbPath);

  try {
    const context: ServiceContext = {
      db,
      actor: null,
      clock: fixedClock("2026-04-01T09:30:00.000Z")
    };
    const issue = getIssue(context, identifier);

    return {
      stateId: issue.stateId,
      activity: listActivity(context, { issue: identifier })
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
