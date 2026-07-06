import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProgram, run } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("tracker CLI", () => {
  it("prints the LF-57 command surface in help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: tracker [options] [command]");
    expect(help).toContain("issue");
    expect(help).toContain("project");
    expect(help).toContain("team");
  });

  it("initializes a temp DB, creates a project and issue, and lists JSON records", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect(
      (await tracker(dbPath, ["project", "create", "Platform Foundations", "--status", "planned"]))
        .status
    ).toBe(0);
    expect(
      (await tracker(dbPath, [
        "issue",
        "create",
        "--title",
        "Set up CI",
        "--project",
        "Platform Foundations",
        "--priority",
        "2"
      ])).status
    ).toBe(0);

    const list = await tracker(dbPath, ["issue", "list", "--json"]);
    expect(list.status).toBe(0);

    const records = JSON.parse(list.stdout) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      identifier: "ENG-1",
      title: "Set up CI",
      priority: 2,
      description: null,
      assigneeId: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null
    });
    expect(records[0]?.projectId).toEqual(expect.any(String));
  });

  it("moves an issue to a new workflow state", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect(
      (await tracker(dbPath, ["issue", "create", "--title", "Implement lifecycle states"])).status
    ).toBe(0);

    const moved = await tracker(dbPath, ["issue", "move", "ENG-1", "In Progress", "--json"]);
    expect(moved.status).toBe(0);

    const movedIssue = JSON.parse(moved.stdout) as Record<string, unknown>;
    expect(movedIssue.startedAt).toEqual(expect.any(String));

    const started = await tracker(dbPath, ["issue", "list", "--state", "In Progress", "--json"]);
    expect(started.status).toBe(0);

    const records = JSON.parse(started.stdout) as Array<Record<string, unknown>>;
    expect(records.map((record) => record.identifier)).toEqual(["ENG-1"]);
  });

  it("filters issue list JSON by priority", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Fix release blocker",
          "--priority",
          "1"
        ])
      ).status
    ).toBe(0);
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Tidy help output",
          "--priority",
          "4"
        ])
      ).status
    ).toBe(0);

    const filtered = await tracker(dbPath, ["issue", "list", "--priority", "1", "--json"]);
    expect(filtered.status).toBe(0);

    const records = JSON.parse(filtered.stdout) as Array<Record<string, unknown>>;
    expect(records.map((record) => record.identifier)).toEqual(["ENG-1"]);
    expect(records.map((record) => record.priority)).toEqual([1]);
  });

  it("creates and clears sub-issues through parent flags and shows relationships in view JSON", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const parentResult = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Build issue hierarchy",
      "--json"
    ]);
    expect(parentResult.status).toBe(0);
    const parent = JSON.parse(parentResult.stdout) as Record<string, unknown>;

    const childResult = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Add child issue",
      "--parent",
      "ENG-1",
      "--json"
    ]);
    expect(childResult.status).toBe(0);
    const child = JSON.parse(childResult.stdout) as Record<string, unknown>;
    expect(child).toMatchObject({
      identifier: "ENG-2",
      parentId: parent.id,
      parent: { identifier: "ENG-1" }
    });

    const parentView = await tracker(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(parentView.status).toBe(0);
    expect(JSON.parse(parentView.stdout)).toMatchObject({
      identifier: "ENG-1",
      parent: null,
      children: [{ identifier: "ENG-2", title: "Add child issue" }]
    });

    const cleared = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-2",
      "--parent",
      "none",
      "--json"
    ]);
    expect(cleared.status).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      identifier: "ENG-2",
      parentId: null,
      parent: null
    });
  });

  it("creates, lists, archives, and applies labels through JSON commands", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const createdLabel = await tracker(dbPath, [
      "label",
      "create",
      "Bug",
      "--color",
      "#EF4444",
      "--json"
    ]);
    expect(createdLabel.status).toBe(0);
    expect(JSON.parse(createdLabel.stdout)).toMatchObject({
      name: "Bug",
      color: "#EF4444",
      group: null,
      archivedAt: null
    });

    expect((await tracker(dbPath, ["label", "create", "Docs", "--color", "#22C55E"])).status).toBe(
      0
    );
    expect(
      (
        await tracker(dbPath, [
          "issue",
          "create",
          "--title",
          "Fix login redirect",
          "--label",
          "Bug"
        ])
      ).status
    ).toBe(0);
    expect((await tracker(dbPath, ["issue", "create", "--title", "Refresh setup guide"])).status).toBe(
      0
    );

    const filtered = await tracker(dbPath, ["issue", "list", "--label", "Bug", "--json"]);
    expect(filtered.status).toBe(0);
    expect((JSON.parse(filtered.stdout) as Array<Record<string, unknown>>).map((issue) => issue.identifier)).toEqual([
      "ENG-1"
    ]);

    const updated = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-1",
      "--label",
      "Docs",
      "--remove-label",
      "Bug",
      "--json"
    ]);
    expect(updated.status).toBe(0);
    expect((JSON.parse(updated.stdout) as { labels: Array<{ name: string }> }).labels.map((label) => label.name)).toEqual([
      "Docs"
    ]);

    const view = await tracker(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(view.status).toBe(0);
    expect((JSON.parse(view.stdout) as { labels: Array<{ name: string }> }).labels.map((label) => label.name)).toEqual([
      "Docs"
    ]);

    const archived = await tracker(dbPath, ["label", "archive", "Bug", "--json"]);
    expect(archived.status).toBe(0);
    expect((JSON.parse(archived.stdout) as Record<string, unknown>).archivedAt).toEqual(
      expect.any(String)
    );

    const visibleLabels = await tracker(dbPath, ["label", "list", "--json"]);
    expect(visibleLabels.status).toBe(0);
    expect(
      (JSON.parse(visibleLabels.stdout) as Array<Record<string, unknown>>).map((label) => label.name)
    ).toEqual(["Docs"]);

    const allLabels = await tracker(dbPath, ["label", "list", "--include-archived", "--json"]);
    expect(allLabels.status).toBe(0);
    expect(
      (JSON.parse(allLabels.stdout) as Array<Record<string, unknown>>).map((label) => label.name)
    ).toEqual(["Bug", "Docs"]);
  });

  it("creates cycles, assigns issues to them, filters by cycle, and rejects duplicates", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const firstCycle = await tracker(dbPath, [
      "cycle",
      "create",
      "Cycle 1",
      "--starts-at",
      "2026-04-01T00:00:00.000Z",
      "--ends-at",
      "2026-04-15T00:00:00.000Z",
      "--json"
    ]);
    expect(firstCycle.status).toBe(0);
    const first = JSON.parse(firstCycle.stdout) as Record<string, unknown>;
    expect(first).toMatchObject({
      number: 1,
      name: "Cycle 1",
      startsAt: "2026-04-01T00:00:00.000Z",
      endsAt: "2026-04-15T00:00:00.000Z"
    });

    const secondCycle = await tracker(dbPath, [
      "cycle",
      "create",
      "--number",
      "2",
      "--name",
      "Cycle 2",
      "--json"
    ]);
    expect(secondCycle.status).toBe(0);
    const second = JSON.parse(secondCycle.stdout) as Record<string, unknown>;
    expect(second).toMatchObject({ number: 2, name: "Cycle 2" });

    const duplicate = await tracker(dbPath, [
      "cycle",
      "create",
      "Duplicate Cycle",
      "--number",
      "1",
      "--json"
    ]);
    expect(duplicate.status).not.toBe(0);
    expect(JSON.parse(duplicate.stderr)).toMatchObject({
      error: { code: "CONSTRAINT_VIOLATION" }
    });

    const created = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Fix cycle assignment",
      "--cycle",
      "1",
      "--json"
    ]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      identifier: "ENG-1",
      cycleId: first.id
    });

    expect((await tracker(dbPath, ["issue", "create", "--title", "Plan next cycle"])).status).toBe(0);

    const updated = await tracker(dbPath, [
      "issue",
      "update",
      "ENG-2",
      "--cycle",
      String(second.id),
      "--json"
    ]);
    expect(updated.status).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      identifier: "ENG-2",
      cycleId: second.id
    });

    const filteredByNumber = await tracker(dbPath, ["issue", "list", "--cycle", "1", "--json"]);
    expect(filteredByNumber.status).toBe(0);
    expect(
      (JSON.parse(filteredByNumber.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-1"]);

    const filteredById = await tracker(dbPath, [
      "issue",
      "list",
      "--cycle",
      String(second.id),
      "--json"
    ]);
    expect(filteredById.status).toBe(0);
    expect(
      (JSON.parse(filteredById.stdout) as Array<Record<string, unknown>>).map(
        (issue) => issue.identifier
      )
    ).toEqual(["ENG-2"]);

    const cycles = await tracker(dbPath, ["cycle", "list", "--json"]);
    expect(cycles.status).toBe(0);
    expect((JSON.parse(cycles.stdout) as Array<{ number: number }>).map((cycle) => cycle.number)).toEqual([
      1,
      2
    ]);
  });

  it("rejects out-of-range priority values", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const result = await tracker(dbPath, [
      "issue",
      "create",
      "--title",
      "Reject invalid priority",
      "--priority",
      "99",
      "--json"
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Input validation failed."
      }
    });
  });

  it("prints an error envelope to stderr with non-zero exit for a bad identifier", async () => {
    const dbPath = tempDbPath();

    expect((await tracker(dbPath, ["init"])).status).toBe(0);

    const result = await tracker(dbPath, ["issue", "view", "ENG-404", "--json"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "ISSUE_NOT_FOUND",
        message: "Issue ENG-404 was not found.",
        details: { identifier: "ENG-404" }
      }
    });
  });
});

function tempDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-cli-"));
  tempDirs.push(tempDir);
  return join(tempDir, "tracker.db");
}

async function tracker(dbPath: string, args: string[]) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";

  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await run(["node", "tracker", "--db", dbPath, ...args]);
    return {
      status: typeof process.exitCode === "number" ? process.exitCode : 0,
      stdout,
      stderr
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
}
