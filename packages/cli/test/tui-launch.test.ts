import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { render } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyMigrations,
  createIssue,
  createLabel,
  createProject,
  createSavedView,
  createTeam,
  getLastSelectedView,
  init,
  openDb,
  setLastSelectedView,
  type ServiceContext
} from "@issue-tracker/core";
import type { LinekeeperStartup } from "@issue-tracker/tui";

import { run } from "../src/index.js";

// Only Ink's renderer is replaced: the real `tracker tui` action, `runLinekeeperTui` and
// `prepareLinekeeperStartup` run, so a failure here is a failure before the UI opens.
vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  render: vi.fn(() => ({ waitUntilExit: async () => {}, unmount() {} }))
}));

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.mocked(render).mockClear();
});

describe("tracker tui startup scope", () => {
  it("starts with a search inside named filters, validated before Ink renders", async () => {
    const dbPath = seed();
    const result = await tracker(dbPath, ["tui", "--search", "ci", "--project", "Demo Project", "--state", "In Progress"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(vi.mocked(render)).toHaveBeenCalledTimes(1);
    const startup = renderedStartup();
    expect(startup.data.issues.map((issue) => issue.title)).toEqual(["CI pipeline"]);
    expect(startup.data.search).toBe("ci");
    expect(startup.data.filters.project).toBe("Demo Project");
    expect(startup.data.filters.state).toBe("In Progress");
  });

  it("layers --filter text and a named team onto a view", async () => {
    const dbPath = seed();
    const result = await tracker(dbPath, ["tui", "--view", "Demo work", "--team", "ENG", "--filter", "label=ci"]);

    expect(result.status).toBe(0);
    const { data } = renderedStartup();
    expect(data.activeView).toBe("Demo work");
    expect(data.activeTeamKey).toBe("ENG");
    expect(data.modifiedView).toBe(true);
    expect(data.filters.label).toBe("ci");
    expect(data.issues.map((issue) => issue.title)).toEqual(["CI pipeline"]);
  });

  it.each([
    [["--team", "ENG", "tui", "--search", "ci"], "ENG"],
    [["tui", "--search", "ci", "--team", "ENG"], "ENG"],
    [["tui", "--view", "Demo work"], null],
    [["--team", "ENG", "tui", "--view", "Demo work"], "ENG"],
    [["tui", "--view", "Demo work", "--filter", "team=all"], null],
    [["tui", "--filter", "team=all"], null],
    [["--team", "ENG", "tui", "--filter", "team=all"], "ENG"],
    [["--team", "ENG", "tui", "--team", "OPS"], "OPS"],
    [["tui", "--filter", "team=OPS", "--team", "ENG"], "ENG"],
    [["--team", "OPS", "tui", "--filter", "team=ENG"], "OPS"],
    [["tui", "--filter", "team=OPS"], "OPS"]
  ])("resolves the team scope for %j as %s", async (args, team) => {
    const dbPath = seed();
    const result = await tracker(dbPath, args);

    expect(result.status).toBe(0);
    expect(renderedStartup().data.activeTeamKey).toBe(team);
  });

  it("ignores the remembered view for the launch without overwriting it", async () => {
    const dbPath = seed((context) => setLastSelectedView(context, "Demo work"));
    const explicit = await tracker(dbPath, ["tui", "--search", "ci"]);

    expect(explicit.status).toBe(0);
    const startup = renderedStartup();
    expect(startup.data.activeView).toBeNull();
    expect(startup.data.search).toBe("ci");
    expect(startup.message).toContain("Ignored remembered view Demo work");
    expect(withContext(dbPath, (context) => getLastSelectedView(context), false)).toBe("Demo work");

    for (const args of [["tui"], ["--team", "ENG", "tui"], ["tui", "--team", "ENG"]]) {
      vi.mocked(render).mockClear();
      const bare = await tracker(dbPath, args);
      expect(bare.status).toBe(0);
      expect(renderedStartup().data.activeView).toBe("Demo work");
      expect(renderedStartup().message).toBe("Restored view Demo work.");
    }
  });

  it.each([
    [["tui", "--filter", "bogus=1"], "VALIDATION_FAILED", /Unknown filter "bogus"/],
    [["tui", "--view", "nope"], "SAVED_VIEW_NOT_FOUND", /nope/],
    [["tui", "--priority", "7"], "VALIDATION_FAILED", /Input validation failed/],
    [["tui", "--project", "x", "--no-project"], "VALIDATION_FAILED", /choose --project or --no-project/],
    [["tui", "--search", ""], "VALIDATION_FAILED", /--search requires a non-empty value/],
    [["tui", "--filter", "   "], "VALIDATION_FAILED", /--filter requires a non-empty value/]
  ])("rejects %j before rendering", async (args, code, message) => {
    const dbPath = seed();
    const result = await tracker(dbPath, args);

    expect(result.status).toBe(1);
    expect(vi.mocked(render)).not.toHaveBeenCalled();
    const envelope = JSON.parse(result.stderr.trim()) as { error: { code: string; message: string; details?: unknown } };
    expect(envelope.error.code).toBe(code);
    expect(envelope.error.message).toMatch(message);
    if (args.includes("--priority")) expect(JSON.stringify(envelope.error.details)).toContain("priority");
  });

  it("documents the startup options and their precedence in --help", async () => {
    const dbPath = seed();
    const result = await tracker(dbPath, ["tui", "--help"]);

    expect(result.status).toBe(0);
    for (const flag of ["--search", "--view", "--filter", "--project", "--state", "--assignee", "--label", "--priority", "--team", "--unassigned", "--no-project"]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain("Precedence:");
    expect(result.stdout).toContain("not saved as the last selected view");
    expect(result.stdout).toContain("--team may be given before or after");
    expect(vi.mocked(render)).not.toHaveBeenCalled();
  });
});

function renderedStartup(): LinekeeperStartup {
  const element = vi.mocked(render).mock.calls[0]![0] as { props: { startup: LinekeeperStartup } };
  return element.props.startup;
}

function seed(extra?: (context: ServiceContext) => void): string {
  const dbPath = tempDbPath();
  withContext(dbPath, (context) => {
    createProject(context, { name: "Demo Project" });
    createTeam(context, { key: "OPS", name: "Operations" });
    createLabel(context, { name: "ci" });
    createIssue(context, { title: "CI pipeline", project: "Demo Project", state: "In Progress", labels: ["ci"] });
    createIssue(context, { title: "CI docs" });
    createIssue(context, { title: "Deploy checklist", project: "Demo Project" });
    createIssue(context, { title: "CI runners", team: "OPS" });
    createSavedView(context, { name: "Demo work", filters: { project: "Demo Project" } });
    extra?.(context);
  });
  return dbPath;
}

function withContext<T>(dbPath: string, work: (context: ServiceContext) => T, initialize = true): T {
  const db = openDb(dbPath);
  try {
    applyMigrations(db);
    const context: ServiceContext = { db, actor: null, clock: { now: () => new Date("2026-07-01T00:00:00.000Z") } };
    if (initialize) context.actor = init(context).actor;
    return work(context);
  } finally {
    db.$client.close();
  }
}

function tempDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-tui-launch-"));
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
