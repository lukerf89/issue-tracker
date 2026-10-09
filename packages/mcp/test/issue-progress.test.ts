import { afterEach, expect, it } from "vitest";
import { addAttachment, createIssue, exportSnapshot, getIssueProgress, importSnapshot, listActivity, listStatesForTeam, moveIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

const fixtures: Array<Awaited<ReturnType<typeof agentFixture>>> = [];
async function fixture() { const value = await agentFixture(); fixtures.push(value); return value; }
afterEach(async () => { for (const value of fixtures.splice(0)) await value.close(); });

it("separates review, validation, and publication progress across MCP and CLI", async () => {
  const f = await fixture();
  expect(listStatesForTeam(f.context, "ENG").map((state) => state.name)).toContain("Ready for Review");
  const parent = createIssue(f.context, { title: "Release fictional CI work" });
  const child = createIssue(f.context, { title: "Implement fictional CI", parent: parent.identifier });
  addAttachment(f.context, { issue: parent.identifier, kind: "branch", title: "CI branch", repoPath: "/fictional/repo", branchName: "codex/ci" });
  const moved = await f.call("batch_move_issues", { moves: [{ identifier: child.identifier, state: "Ready for Review", expectedRevision: child.revision }] });
  expect(moved.error).toBe(false);
  expect(moved.data).toMatchObject({ applied: 1, failed: 0, results: [{ identifier: child.identifier, from: "Todo", to: "Ready for Review", error: null }] });
  const revision = moved.data.results[0].revision;
  const progress = await f.call("update_issue_progress", { identifier: child.identifier, expectedRevision: revision, operations: [
    { type: "criterion", action: "add", text: "Benchmarks pass", status: "pending" },
    { type: "blocker", action: "add", kind: "network", description: "Remote unavailable", unblockAction: "Retry PR publication", owner: "release owner" }
  ] });
  expect(progress.error).toBe(false);
  expect(progress.data.changes).toHaveLength(2);
  const criterionId = progress.data.changes[0].id;
  const blockerId = progress.data.changes[1].id;
  const read = await f.call("get_issue_progress", { identifier: parent.identifier });
  expect(read.error).toBe(false);
  expect(read.data).toMatchObject({ childCount: 1, statusCounts: { "Ready for Review": 1 }, remainingCriteria: 1, unresolvedBlockers: 1, children: [{ identifier: child.identifier, remainingCriteria: 1, unresolvedBlockers: 1 }], links: [{ kind: "branch", branchName: "codex/ci" }] });
  expect(JSON.parse(f.cli(["issue", "progress", parent.identifier, "--json"]))).toEqual(read.data);
  const updated = JSON.parse(f.cli(["issue", "progress-update", child.identifier, "--expected-revision", String(progress.data.revision), "--operations", JSON.stringify([
    { type: "criterion", action: "update", id: criterionId, status: "passed", evidenceUrl: "https://example.test/benchmarks" },
    { type: "blocker", action: "update", id: blockerId, resolved: true }
  ]), "--json"]));
  expect(updated.changes).toHaveLength(2);
  expect(getIssueProgress(f.context, { identifier: parent.identifier })).toMatchObject({ remainingCriteria: 0, unresolvedBlockers: 0 });
  const projected = await f.call("get_issue", { identifier: child.identifier, fields: ["identifier", "title"], comments: "none" });
  expect(projected.error).toBe(false);
  expect(projected.data.data).toMatchObject({ identifier: child.identifier });
  const noComments = await f.call("get_issue", { identifier: child.identifier, fields: ["identifier", "comments"], comments: "none" });
  expect(noComments.data.data).toEqual({ identifier: child.identifier });
});

it("makes batch rollback and partial failure explicit with revision checks", async () => {
  const f = await fixture();
  const first = createIssue(f.context, { title: "First fictional task" });
  const second = createIssue(f.context, { title: "Second fictional task" });
  const moves = [{ identifier: first.identifier, state: "Ready for Review", expectedRevision: first.revision }, { identifier: second.identifier, state: "Done", expectedRevision: second.revision + 1 }];
  const atomic = await f.call("batch_move_issues", { moves });
  expect(atomic.error).toBe(true);
  expect(atomic.data.error.code).toBe("VALIDATION_FAILED");
  expect(getIssueProgress(f.context, { identifier: first.identifier }).state).toBe("Todo");
  const partial = JSON.parse(f.cli(["issue", "move-batch", "--moves", JSON.stringify(moves), "--on-error", "continue", "--json"]));
  expect(partial).toMatchObject({ applied: 1, failed: 1, results: [{ identifier: first.identifier, to: "Ready for Review", error: null }, { identifier: second.identifier, error: { code: "ISSUE_CONFLICT" } }] });
  const duplicate = await f.call("batch_move_issues", { moves: [moves[0], moves[0]] });
  expect(duplicate.error).toBe(true);
});

it("round-trips criteria and blockers in portable snapshots", async () => {
  const source = await fixture();
  const target = await fixture();
  const issue = createIssue(source.context, { title: "Fictional validation" });
  const changed = await source.call("update_issue_progress", { identifier: issue.identifier, operations: [
    { type: "criterion", action: "add", text: "Check throughput" },
    { type: "blocker", action: "add", kind: "evaluation_data", description: "No sample", unblockAction: "Collect sample", owner: "QA" }
  ] });
  expect(changed.error).toBe(false);
  importSnapshot(target.context, exportSnapshot(source.context), { force: true });
  expect(getIssueProgress(target.context, { identifier: issue.identifier })).toEqual(getIssueProgress(source.context, { identifier: issue.identifier }));
});

it("counts unresolved issue dependencies and child delivery links", async () => {
  const f = await fixture();
  const parent = createIssue(f.context, { title: "Fictional release" });
  const blocker = createIssue(f.context, { title: "Fictional dependency" });
  const child = createIssue(f.context, { title: "Fictional build", parent: parent.identifier, blockedBy: [blocker.identifier] });
  addAttachment(f.context, { issue: child.identifier, kind: "pr", title: "Build PR", repoPath: "/fictional/repo", url: "https://example.test/pr/1" });
  expect(getIssueProgress(f.context, { identifier: parent.identifier })).toMatchObject({
    unresolvedBlockers: 1, children: [{ identifier: child.identifier, unresolvedBlockers: 1, links: [{ kind: "pr", url: "https://example.test/pr/1" }] }]
  });
  moveIssue(f.context, blocker.identifier, "Done");
  expect(getIssueProgress(f.context, { identifier: parent.identifier }).unresolvedBlockers).toBe(0);
  const first = await f.call("update_issue_progress", { identifier: child.identifier, operations: [{ type: "criterion", action: "add", text: "Verify build" }] });
  const id = first.data.changes[0].id;
  const before = listActivity(f.context, { issue: child.identifier });
  const unchanged = await f.call("update_issue_progress", { identifier: child.identifier, expectedRevision: first.data.revision, operations: [{ type: "criterion", action: "update", id, status: "pending" }] });
  expect(unchanged.data).toMatchObject({ revision: first.data.revision, changes: [] });
  expect(listActivity(f.context, { issue: child.identifier })).toEqual(before);
});
