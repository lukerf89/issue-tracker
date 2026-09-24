import { expect, it } from "vitest";
import { addRepository, archiveIssue, associateRepository, createIssue, createProject, createSavedView, listSavedViews, moveIssue, updateIssue } from "@issue-tracker/core";
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
