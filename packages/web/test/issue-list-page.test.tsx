import { rmSync } from "node:fs";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import IssueListPage from "../app/page";
import { seedFilteredIssueListDb } from "./issue-list-fixture";

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

describe("issue list page", () => {
  it("renders core-backed issues as linked rows and applies URL filters", async () => {
    const seeded = seedFilteredIssueListDb(tempDirs);
    process.env.ISSUE_TRACKER_DB = seeded.dbPath;

    render(await IssueListPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("link", { name: "ENG-1 Implement filtered issue list" })
    ).toHaveAttribute("href", "/issues/ENG-1");
    expect(screen.getByText("Keep backlog issue visible")).toBeInTheDocument();
    expect(screen.queryByText("Archived filtered list cleanup")).not.toBeInTheDocument();

    cleanup();

    render(
      await IssueListPage({
        searchParams: Promise.resolve({
          state: "In Progress",
          assignee: "build-agent",
          project: seeded.projectId,
          label: "Frontend",
          priority: "1",
          cycle: String(seeded.cycleNumber)
        })
      })
    );

    expect(
      screen.getByRole("link", { name: "ENG-1 Implement filtered issue list" })
    ).toHaveAttribute("href", "/issues/ENG-1");
    expect(screen.queryByText("Keep backlog issue visible")).not.toBeInTheDocument();
    expect(screen.queryByText("Unassigned frontend task")).not.toBeInTheDocument();
    expect(screen.queryByText("Document list filters")).not.toBeInTheDocument();
    expect(screen.queryByText("Render docs label")).not.toBeInTheDocument();
    expect(screen.queryByText("Tune filter density")).not.toBeInTheDocument();
    expect(screen.queryByText("Plan next cycle")).not.toBeInTheDocument();
    expect(screen.queryByText("Archived filtered list cleanup")).not.toBeInTheDocument();
  });

});
