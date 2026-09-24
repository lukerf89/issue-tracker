import { expect, it } from "vitest";
import { addRepository, archiveIssue, associateRepository, createActor, createCycle, createIssue, createLabel, createProject, createSavedView, createTeam, listIssueFiltersSchema, listSavedViews, moveIssue, updateIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

it("selects actionable work by effective repository, readiness, dates and priority with adapter parity", async () => {
  const f = await agentFixture();
  try {
    const inspector = { inspect: (path: string) => ({ canonicalPath: path, commonDir: path + "/.git", defaultBranch: "main", headCommit: "a".repeat(40), dirty: false, instructionFiles: [], instructions: {} }) };
    const command = { executable: "node", args: ["--version"] };
    const repo = addRepository(f.context, { name: "build", path: "/tmp/fictional-build", testCommand: command, verificationCommand: command }, inspector);
    const other = addRepository(f.context, { name: "other", path: "/tmp/fictional-other", testCommand: command, verificationCommand: command }, inspector);
    const project = createProject(f.context, { name: "Platform" });
    associateRepository(f.context, { repository: repo.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
    const blocker = createIssue(f.context, { title: "CI prerequisite" });
    const blocked = createIssue(f.context, { title: "CI blocked", priority: 1, project: project.id, blockedBy: [blocker.identifier], dueDate: "2026-02-01" });
    const ready = createIssue(f.context, { title: "CI ready", priority: 2, project: project.id, dueDate: "2026-02-01" });
    createIssue(f.context, { title: "CI no priority", project: project.id, dueDate: "2026-02-01" });
    const overridden = createIssue(f.context, { title: "CI override", priority: 1, project: project.id });
    associateRepository(f.context, { repository: other.id, issue: overridden.identifier, position: 0, isDefault: false, overrideKind: "replace" });
    const filters = { repository: "build", ready: true, assignee: null, sort: "priority", dueFrom: "2026-02-01", dueTo: "2026-02-01", updatedSince: "2026-01-01T00:00:00Z" };
    const page = await f.call("list_issues", filters);
    expect(page.error).toBe(false);
    expect(page.data.issues.map((row: { identifier: string }) => row.identifier)).toEqual([ready.identifier, "ENG-4"]);
    expect(JSON.parse(f.cli(["issue", "list", "--repository", "build", "--ready", "--unassigned", "--sort", "priority", "--due-from", "2026-02-01", "--due-to", "2026-02-01", "--updated-since", "2026-01-01T00:00:00Z", "--json"]))).toEqual(page.data);
    createSavedView(f.context, { name: "Ready build", filters: { ...filters, sort: "priority" } });
    expect((await f.call("list_issues", { view: "Ready build" })).data).toEqual(page.data);
    expect((await f.call("search", { ...filters, query: "CI" })).data.issues.map((row: { identifier: string }) => row.identifier)).toEqual([ready.identifier, "ENG-4"]);
    moveIssue(f.context, blocker.identifier, "Done");
    expect((await f.call("list_issues", filters)).data.issues[0].identifier).toBe(blocked.identifier);
    moveIssue(f.context, blocker.identifier, "Todo");
    archiveIssue(f.context, blocker.identifier);
    expect((await f.call("list_issues", filters)).data.issues[0].identifier).toBe(blocked.identifier);
    updateIssue(f.context, ready.identifier, { parent: blocked.identifier });
    expect((await f.call("list_issues", { parent: blocked.identifier })).data.issues[0].identifier).toBe(ready.identifier);
    expect((await f.call("list_issues", { blockedBy: blocker.identifier })).data.issues[0].identifier).toBe(blocked.identifier);
    expect((await f.call("list_issues", { blocks: blocked.identifier, includeArchived: true })).data.issues[0].identifier).toBe(blocker.identifier);
    for (const invalid of [{ repository: "missing" }, { parent: "ENG-999" }, { dueFrom: "2026-03-01", dueTo: "2026-01-01" }, { updatedSince: "yesterday" }]) expect((await f.call("list_issues", invalid)).error).toBe(true);
  } finally { await f.close(); }
});

const ids = (page: { data: { issues: Array<{ identifier: string }> } }) => page.data.issues.map((row) => row.identifier);

it("sorts by priority (0 last) and by newest update, independently of identifier order", async () => {
  const f = await agentFixture();
  try {
    for (const priority of [0, 3, 1, 2]) createIssue(f.context, { title: `CI step p${priority}`, priority });
    expect(ids(await f.call("list_issues", {}))).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4"]);
    expect(ids(await f.call("list_issues", { sort: "priority" }))).toEqual(["ENG-3", "ENG-4", "ENG-2", "ENG-1"]);

    f.context.clock = { now: () => new Date("2026-01-05T00:00:00Z") };
    updateIssue(f.context, "ENG-2", { title: "CI step renamed" });
    f.context.clock = { now: () => new Date("2026-01-06T00:00:00Z") };
    updateIssue(f.context, "ENG-4", { title: "CI step renamed again" });
    expect(ids(await f.call("list_issues", { sort: "updatedAt" }))).toEqual(["ENG-4", "ENG-2", "ENG-1", "ENG-3"]);
    expect(ids(await f.call("search", { query: "CI", sort: "updatedAt" }))).toEqual(["ENG-4", "ENG-2", "ENG-1", "ENG-3"]);
  } finally { await f.close(); }
});

it("lets an issue repository override replace project routing", async () => {
  const f = await agentFixture();
  try {
    const inspector = { inspect: (path: string) => ({ canonicalPath: path, commonDir: path + "/.git", defaultBranch: "main", headCommit: "a".repeat(40), dirty: false, instructionFiles: [], instructions: {} }) };
    const command = { executable: "node", args: ["--version"] };
    addRepository(f.context, { name: "build", path: "/tmp/fictional-build", testCommand: command, verificationCommand: command }, inspector);
    addRepository(f.context, { name: "other", path: "/tmp/fictional-other", testCommand: command, verificationCommand: command }, inspector);
    const project = createProject(f.context, { name: "Platform" });
    associateRepository(f.context, { repository: "build", project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
    createIssue(f.context, { title: "Routed by project", project: project.id });
    createIssue(f.context, { title: "Routed by override", project: project.id });
    associateRepository(f.context, { repository: "other", issue: "ENG-2", position: 0, isDefault: false, overrideKind: "replace" });
    expect(ids(await f.call("list_issues", { repository: "build" }))).toEqual(["ENG-1"]);
    expect(ids(await f.call("list_issues", { repository: "other" }))).toEqual(["ENG-2"]);
  } finally { await f.close(); }
});

it("filters by due range, workflow category, readiness complement and parent", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Due early", dueDate: "2026-01-31" });
    createIssue(f.context, { title: "Due on start", dueDate: "2026-02-01" });
    createIssue(f.context, { title: "Due on end", dueDate: "2026-02-28" });
    createIssue(f.context, { title: "Due late", dueDate: "2026-03-01" });
    expect(ids(await f.call("list_issues", { dueFrom: "2026-02-01", dueTo: "2026-02-28" }))).toEqual(["ENG-2", "ENG-3"]);

    moveIssue(f.context, "ENG-1", "Blocked");
    moveIssue(f.context, "ENG-2", "In Progress");
    expect(ids(await f.call("list_issues", { stateTypes: ["blocked"] }))).toEqual(["ENG-1"]);
    expect(ids(await f.call("list_issues", { ready: false }))).toEqual(["ENG-1", "ENG-2"]);
    expect(JSON.parse(f.cli(["issue", "list", "--not-ready", "--json"])).issues.map((row: { identifier: string }) => row.identifier)).toEqual(["ENG-1", "ENG-2"]);

    updateIssue(f.context, "ENG-4", { parent: "ENG-3" });
    expect(ids(await f.call("list_issues", { parent: null }))).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(JSON.parse(f.cli(["issue", "list", "--no-parent", "--json"])).issues.map((row: { identifier: string }) => row.identifier)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    for (const invalid of [{ blockedBy: "ENG-999" }, { blocks: "ENG-999" }]) {
      expect((await f.call("list_issues", invalid)).data.error.code).toBe("ISSUE_NOT_FOUND");
    }
  } finally { await f.close(); }
});

it("treats a canceled blocker as resolved and saves the new filters from the CLI", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "CI prerequisite" });
    createIssue(f.context, { title: "CI blocked", blockedBy: ["ENG-1"] });
    expect(ids(await f.call("list_issues", { ready: true }))).toEqual(["ENG-1"]);
    moveIssue(f.context, "ENG-1", "Canceled");
    expect(ids(await f.call("list_issues", { ready: true }))).toEqual(["ENG-2"]);

    f.cli(["view", "save", "Ready by priority", "--ready", "--no-parent", "--sort", "priority", "--state-types", "backlog,unstarted", "--json"]);
    const saved = listSavedViews(f.context).find((view) => view.name === "Ready by priority")!;
    expect(saved.filters).toMatchObject({ ready: true, parent: null, sort: "priority", stateTypes: ["backlog", "unstarted"] });
  } finally { await f.close(); }
});

// ── LF-141: exhaustive CLI `issue search` ↔ MCP `search` contract ────────────────────────────

type AgentFixture = Awaited<ReturnType<typeof agentFixture>>;

/**
 * Fictional workspace in which every filter selects a distinct, non-empty subset of the
 * "CI" matches, so no parity row can pass because both adapters returned nothing.
 */
function seedSearchParity(f: AgentFixture) {
  const inspector = { inspect: (path: string) => ({ canonicalPath: path, commonDir: path + "/.git", defaultBranch: "main", headCommit: "a".repeat(40), dirty: false, instructionFiles: [], instructions: {} }) };
  const command = { executable: "node", args: ["--version"] };
  createActor(f.context, { type: "agent", name: "Build Agent", handle: "build-agent" });
  createTeam(f.context, { key: "OPS", name: "Operations" });
  const project = createProject(f.context, { name: "Platform" });
  createLabel(f.context, { name: "infra" });
  createCycle(f.context, { team: "ENG", number: 1 });
  addRepository(f.context, { name: "build", path: "/tmp/fictional-build", testCommand: command, verificationCommand: command }, inspector);
  associateRepository(f.context, { repository: "build", project: project.id, position: 0, isDefault: true, overrideKind: "replace" });
  createIssue(f.context, { title: "Set up CI", project: "Platform", assignee: "build-agent", labels: ["infra"], priority: 2, dueDate: "2026-02-10", cycle: 1 }); // ENG-1
  createIssue(f.context, { title: "CI cache warmup", parent: "ENG-1", priority: 1, dueDate: "2026-03-15" }); // ENG-2
  createIssue(f.context, { title: "CI flaky retries", priority: 3 }); // ENG-3
  createIssue(f.context, { title: "CI runner image", blocks: ["ENG-3"] }); // ENG-4
  createIssue(f.context, { title: "CI archived notes", project: "Platform" }); // ENG-5
  createIssue(f.context, { title: "Docs refresh" }); // ENG-6 — never matches the query
  createIssue(f.context, { title: "CI ops runbook", team: "OPS" }); // OPS-1
  moveIssue(f.context, "ENG-2", "In Progress");
  archiveIssue(f.context, "ENG-5");
  f.context.clock = { now: () => new Date("2026-01-10T00:00:00Z") };
  updateIssue(f.context, "ENG-3", { title: "CI flaky retries fixed" });
}

interface ParityRow {
  /** The ListIssueFilters key this row exercises. */
  key: string;
  mcp: Record<string, unknown>;
  cli: string[];
  /** Expected identifiers; compared in order when `ordered`, otherwise as a set. */
  expected: string[];
  ordered?: boolean;
}

const ACTIVE_CI = ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "OPS-1"];
const PARITY_ROWS: ParityRow[] = [
  { key: "query", mcp: {}, cli: [], expected: ACTIVE_CI },
  { key: "state", mcp: { state: "In Progress" }, cli: ["--state", "In Progress"], expected: ["ENG-2"] },
  { key: "stateTypes", mcp: { stateTypes: ["started"] }, cli: ["--state-types", "started"], expected: ["ENG-2"] },
  { key: "ready", mcp: { ready: true }, cli: ["--ready"], expected: ["ENG-1", "ENG-4", "OPS-1"] },
  { key: "ready", mcp: { ready: false }, cli: ["--not-ready"], expected: ["ENG-2", "ENG-3"] },
  { key: "parent", mcp: { parent: "ENG-1" }, cli: ["--parent", "ENG-1"], expected: ["ENG-2"] },
  { key: "parent", mcp: { parent: null }, cli: ["--no-parent"], expected: ["ENG-1", "ENG-3", "ENG-4", "OPS-1"] },
  { key: "blockedBy", mcp: { blockedBy: "ENG-4" }, cli: ["--blocked-by", "ENG-4"], expected: ["ENG-3"] },
  { key: "blocks", mcp: { blocks: "ENG-3" }, cli: ["--blocks", "ENG-3"], expected: ["ENG-4"] },
  { key: "repository", mcp: { repository: "build" }, cli: ["--repository", "build"], expected: ["ENG-1"] },
  { key: "updatedSince", mcp: { updatedSince: "2026-01-05T00:00:00Z" }, cli: ["--updated-since", "2026-01-05T00:00:00Z"], expected: ["ENG-3"] },
  { key: "dueFrom", mcp: { dueFrom: "2026-03-01" }, cli: ["--due-from", "2026-03-01"], expected: ["ENG-2"] },
  { key: "dueTo", mcp: { dueTo: "2026-02-28" }, cli: ["--due-to", "2026-02-28"], expected: ["ENG-1"] },
  { key: "sort", mcp: { sort: "priority" }, cli: ["--sort", "priority"], expected: ["ENG-2", "ENG-1", "ENG-3", "ENG-4", "OPS-1"], ordered: true },
  { key: "sort", mcp: { sort: "updatedAt" }, cli: ["--sort", "updatedAt"], expected: ["ENG-3", "ENG-1", "ENG-2", "ENG-4", "OPS-1"], ordered: true },
  { key: "assignee", mcp: { assignee: "build-agent" }, cli: ["--assignee", "build-agent"], expected: ["ENG-1"] },
  { key: "assignee", mcp: { assignee: null }, cli: ["--unassigned"], expected: ["ENG-2", "ENG-3", "ENG-4", "OPS-1"] },
  { key: "project", mcp: { project: "Platform" }, cli: ["--project", "Platform"], expected: ["ENG-1"] },
  { key: "project", mcp: { project: null }, cli: ["--no-project"], expected: ["ENG-2", "ENG-3", "ENG-4", "OPS-1"] },
  { key: "team", mcp: { team: "OPS" }, cli: ["--team", "OPS"], expected: ["OPS-1"] },
  { key: "priority", mcp: { priority: 1 }, cli: ["--priority", "1"], expected: ["ENG-2"] },
  { key: "label", mcp: { label: "infra" }, cli: ["--label", "infra"], expected: ["ENG-1"] },
  { key: "cycle", mcp: { cycle: 1 }, cli: ["--cycle", "1"], expected: ["ENG-1"] },
  { key: "limit", mcp: { limit: 2, sort: "identifier" }, cli: ["--limit", "2", "--sort", "identifier"], expected: ["ENG-1", "ENG-2"], ordered: true },
  { key: "includeArchived", mcp: { includeArchived: true }, cli: ["--include-archived"], expected: [...ACTIVE_CI, "ENG-5"] }
];

it("covers every ListIssueFilters key and null alias in the search parity table", () => {
  expect([...new Set(PARITY_ROWS.map((row) => row.key))].sort()).toEqual(Object.keys(listIssueFiltersSchema.shape).sort());
  for (const alias of [{ assignee: null }, { project: null }, { parent: null }, { ready: false }]) {
    expect(PARITY_ROWS.some((row) => JSON.stringify(row.mcp) === JSON.stringify(alias))).toBe(true);
  }
});

it("returns byte-identical search JSON from MCP search and CLI issue search for every filter", async () => {
  const f = await agentFixture();
  try {
    seedSearchParity(f);
    for (const row of PARITY_ROWS) {
      const label = `${row.key} ${row.cli.join(" ")}`;
      const mcp = await f.call("search", { query: "ci", ...row.mcp });
      expect(mcp.error, label).toBe(false);
      const cliOutput = f.cli(["issue", "search", "ci", ...row.cli, "--json"]);
      expect(cliOutput, label).toBe(`${JSON.stringify(mcp.data)}\n`);
      const got = ids(mcp);
      if (row.ordered) expect(got, label).toEqual(row.expected);
      else expect([...got].sort(), label).toEqual([...row.expected].sort());
    }
    // The query itself is case-insensitive and excludes non-matching issues.
    expect(ids(await f.call("search", { query: "CI" })).sort()).toEqual(ACTIVE_CI);
    expect(ids(await f.call("search", { query: "docs" }))).toEqual(["ENG-6"]);
  } finally { await f.close(); }
});

it("keeps projection, cursors, errors and saved views in parity across adapters", async () => {
  const f = await agentFixture();
  try {
    seedSearchParity(f);
    const fields = ["stateName", "assigneeHandle", "revision"];
    const projected = await f.call("search", { query: "ci", assignee: "build-agent", fields });
    expect(projected.data.issues).toEqual([expect.objectContaining({ identifier: "ENG-1", stateName: expect.any(String), assigneeHandle: "build-agent", revision: expect.any(Number) })]);
    expect(JSON.parse(f.cli(["issue", "search", "ci", "--assignee", "build-agent", "--fields", fields.join(","), "--json"]))).toEqual(projected.data);

    // A cursor minted by the CLI continues the same search over MCP.
    const cliPage1 = JSON.parse(f.cli(["issue", "search", "ci", "--limit", "2", "--json"]));
    expect(cliPage1.nextCursor).toEqual(expect.any(String));
    const cliPage2 = JSON.parse(f.cli(["issue", "search", "ci", "--limit", "2", "--cursor", cliPage1.nextCursor, "--json"]));
    const mcpPage2 = await f.call("search", { query: "ci", limit: 2, cursor: cliPage1.nextCursor });
    expect(mcpPage2.data).toEqual(cliPage2);
    expect(ids(mcpPage2)).toHaveLength(2);
    expect(ids(mcpPage2).some((id) => ids({ data: cliPage1 }).includes(id))).toBe(false);

    for (const [mcpArgs, cliArgs] of [
      [{ project: "Missing" }, ["--project", "Missing"]],
      [{ dueFrom: "2026-03-01", dueTo: "2026-01-01" }, ["--due-from", "2026-03-01", "--due-to", "2026-01-01"]],
      [{ updatedSince: "yesterday" }, ["--updated-since", "yesterday"]]
    ] as Array<[Record<string, unknown>, string[]]>) {
      const mcp = await f.call("search", { query: "ci", ...mcpArgs });
      expect(mcp.error).toBe(true);
      expect(f.cliError(["issue", "search", "ci", ...cliArgs, "--json"]).code).toBe(mcp.data.error.code);
    }

    // Saved view + query: `issue list --view V --query` is the CLI spelling of list_issues {view, query}.
    f.cli(["view", "save", "Platform history", "--project", "Platform", "--include-archived", "--json"]);
    const viaMcp = await f.call("create_saved_view", { name: "Platform history (mcp)", filters: { project: "Platform", includeArchived: true } });
    expect(viaMcp.error).toBe(false);
    const saved = listSavedViews(f.context);
    expect(saved.find((view) => view.name === "Platform history")!.filters).toEqual(saved.find((view) => view.name === "Platform history (mcp)")!.filters);
    const viewPage = await f.call("list_issues", { view: "Platform history", query: "ci" });
    expect(ids(viewPage)).toEqual(["ENG-1", "ENG-5"]);
    expect(JSON.parse(f.cli(["issue", "list", "--view", "Platform history", "--query", "ci", "--json"]))).toEqual(viewPage.data);
  } finally { await f.close(); }
});
