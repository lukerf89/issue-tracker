import { expect, it } from "vitest";
import { addRepository, archiveIssue, associateRepository, createIssue, createProject, createSavedView, moveIssue, updateIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

it("selects actionable work by effective repository, readiness, dates and priority with adapter parity", async () => {
  const f = await agentFixture();
  try {
    const inspector = { inspect: (path: string) => ({ canonicalPath: path, commonDir: path + "/.git", defaultBranch: "main", headCommit: "a".repeat(40), dirty: false, instructionFiles: [], instructions: {} }) };
    const command = { executable: "node", args: ["--version"] };
    const repo = addRepository(f.context, { name: "build", path: "/tmp/fictional-build", testCommand: command, verificationCommand: command }, inspector);
    const other = addRepository(f.context, { name: "other", path: "/tmp/fictional-other", testCommand: command, verificationCommand: command }, inspector);
    const project = createProject(f.context, { name: "Platform" });
    associateRepository(f.context, { repository: repo.id, project: project.id, position: 0, isDefault: true, overrideKind: "primary" });
    const blocker = createIssue(f.context, { title: "CI prerequisite" });
    const blocked = createIssue(f.context, { title: "CI blocked", priority: 1, project: project.id, blockedBy: [blocker.identifier], dueDate: "2026-02-01" });
    const ready = createIssue(f.context, { title: "CI ready", priority: 2, project: project.id, dueDate: "2026-02-01" });
    createIssue(f.context, { title: "CI no priority", project: project.id, dueDate: "2026-02-01" });
    const overridden = createIssue(f.context, { title: "CI override", priority: 1, project: project.id });
    associateRepository(f.context, { repository: other.id, issue: overridden.identifier, position: 0, isDefault: false, overrideKind: "primary" });
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
