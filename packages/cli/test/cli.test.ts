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
