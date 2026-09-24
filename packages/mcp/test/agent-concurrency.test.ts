import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { addAttachment, addComment, archiveIssue, assignIssue, createActor, createIssue, createLabel, getIssue, listActivity, openDb, claimIssue, updateIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

const builtCliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/index.js");

it("rejects stale edits and competing claims through MCP and CLI", async () => {
  const f = await agentFixture();
  try {
    const issue = createIssue(f.context, { title: "Set up CI" });
    expect(issue.revision).toBe(1);
    const first = await f.call("update_issue", { identifier: issue.identifier, description: "New requirements", expectedRevision: 1 });
    expect(first.error).toBe(false);
    expect(first.data.revision).toBe(2);
    const stale = await f.call("update_issue", { identifier: issue.identifier, description: "Stale requirements", expectedRevision: 1 });
    expect(stale.data.error.code).toBe("ISSUE_CONFLICT");
    expect(stale.data.error.details.currentRevision).toBe(2);
    const before = listActivity(f.context, { issue: issue.identifier });
    updateIssue(f.context, issue.identifier, { description: "New requirements", expectedRevision: 2 });
    expect(listActivity(f.context, { issue: issue.identifier })).toEqual(before);
    expect((await f.call("claim_issue", { identifier: issue.identifier, expectedRevision: 2 })).error).toBe(false);
    expect(f.cliError(["issue", "claim", issue.identifier, "--json"]).code).toBe("ISSUE_ALREADY_CLAIMED");
    expect(f.cliError(["issue", "update", issue.identifier, "--title", "stale", "--expected-revision", "1", "--json"]).code).toBe("ISSUE_CONFLICT");
    const revision = getIssue(f.context, issue.identifier).revision;
    expect(JSON.parse(f.cli(["issue", "assign", issue.identifier, "--none", "--expected-revision", String(revision), "--json"])).assigneeId).toBe(null);
    const secondActor = createActor(f.context, { type: "agent", name: "Other", handle: "other-agent" });
    const otherDb = openDb(f.dbPath);
    try {
      claimIssue({ ...f.context, db: otherDb, actor: secondActor }, issue.identifier);
      expect((await f.call("claim_issue", { identifier: issue.identifier })).data.error.code).toBe("ISSUE_ALREADY_CLAIMED");
    } finally { otherDb.$client.close(); }
    expect(getIssue(f.context, issue.identifier).description).toBe("New requirements");
  } finally { await f.close(); }
});

it("invalidates revisions for labels, both dependency endpoints, comments and attachments at a fixed clock", async () => {
  const f = await agentFixture();
  try {
    const issue = createIssue(f.context, { title: "CI" });
    const blocker = createIssue(f.context, { title: "Build" });
    createLabel(f.context, { name: "Build" });
    let revision = issue.revision;
    for (const change of [
      () => updateIssue(f.context, issue.identifier, { labels: ["Build"] }),
      () => updateIssue(f.context, issue.identifier, { blockedBy: [blocker.identifier] }),
      () => addComment(f.context, { issue: issue.identifier, body: "Reviewed" }),
      () => addAttachment(f.context, { issue: issue.identifier, kind: "link", url: "https://example.com/ci" })
    ]) {
      change();
      const current = getIssue(f.context, issue.identifier).revision;
      expect(current).toBeGreaterThan(revision);
      expect(() => assignIssue(f.context, issue.identifier, null, { expectedRevision: revision })).toThrow("Issue changed");
      revision = current;
    }
    expect(getIssue(f.context, blocker.identifier).revision).toBeGreaterThan(blocker.revision);
    archiveIssue(f.context, issue.identifier);
    expect((await f.call("claim_issue", { identifier: issue.identifier })).error).toBe(true);
  } finally { await f.close(); }
});

it("allows exactly one of two simultaneous CLI processes to claim an issue", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Concurrent CI claim" });
    const run = promisify(execFile);
    const args = [builtCliPath, "--db", f.dbPath, "issue", "claim", "ENG-1", "--json"];
    const results = await Promise.allSettled([run(process.execPath, args), run(process.execPath, args)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(String(rejected?.status === "rejected" ? rejected.reason.stderr : "")).toContain("ISSUE_ALREADY_CLAIMED");
    expect(listActivity(f.context, { issue: "ENG-1" }).filter((entry) => entry.action === "assigned")).toHaveLength(1);
  } finally { await f.close(); }
});

it("rejects a stale expectedRevision on every guarded mutation without writing", async () => {
  const f = await agentFixture();
  try {
    const issue = createIssue(f.context, { title: "Set up CI" });
    updateIssue(f.context, issue.identifier, { description: "Bump the revision" });
    const current = getIssue(f.context, issue.identifier).revision;
    const stale = current - 1;
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["move_issue", { identifier: issue.identifier, state: "In Progress", expectedRevision: stale }],
      ["archive_issue", { identifier: issue.identifier, expectedRevision: stale }],
      ["comment_on_issue", { issue: issue.identifier, body: "Stale note", expectedRevision: stale }],
      ["link_issue", { issue: issue.identifier, kind: "link", url: "https://example.com/ci", expectedRevision: stale }],
      ["claim_issue", { identifier: issue.identifier, expectedRevision: stale }]
    ];
    const before = listActivity(f.context, { issue: issue.identifier });
    for (const [tool, args] of attempts) {
      const result = await f.call(tool, args);
      expect(result.data.error?.code, tool).toBe("ISSUE_CONFLICT");
      expect(result.data.error.details.currentRevision, tool).toBe(current);
    }
    expect(f.cliError(["issue", "claim", issue.identifier, "--expected-revision", String(stale), "--json"]).code).toBe("ISSUE_CONFLICT");
    expect(listActivity(f.context, { issue: issue.identifier })).toEqual(before);
    expect(getIssue(f.context, issue.identifier).revision).toBe(current);

    archiveIssue(f.context, issue.identifier);
    const archived = getIssue(f.context, issue.identifier).revision;
    const unarchive = await f.call("unarchive_issue", { identifier: issue.identifier, expectedRevision: archived - 1 });
    expect(unarchive.data.error.code).toBe("ISSUE_CONFLICT");
    expect(getIssue(f.context, issue.identifier).archivedAt).not.toBe(null);
  } finally { await f.close(); }
});

it("claims an issue referenced by its UUID", async () => {
  const f = await agentFixture();
  try {
    const issue = createIssue(f.context, { title: "Set up CI" });
    const result = await f.call("claim_issue", { identifier: issue.id });
    expect(result.error).toBe(false);
    expect(result.data.assigneeId).toBe(f.context.actor!.id);
  } finally { await f.close(); }
});

it("keeps every revision trigger installed after all migrations", async () => {
  const f = await agentFixture();
  try {
    // The triggers live only in raw migration SQL; Drizzle does not know them. A later
    // migration that rebuilds one of these tables drops its triggers silently, and stale
    // writers would then overwrite newer data without a conflict.
    const rows = f.context.db.$client
      .prepare("select name from sqlite_master where type = 'trigger' and name like '%revision' order by name")
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual([
      "attachments_delete_revision",
      "attachments_insert_revision",
      "attachments_update_revision",
      "comments_delete_revision",
      "comments_insert_revision",
      "comments_update_revision",
      "dependency_delete_revision",
      "dependency_insert_revision",
      "issue_labels_delete_revision",
      "issue_labels_insert_revision",
      "issue_labels_update_revision",
      "issue_scalar_revision"
    ]);
  } finally { await f.close(); }
});
