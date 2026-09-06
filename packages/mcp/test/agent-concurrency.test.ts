import { expect, it } from "vitest";
import { addAttachment, addComment, archiveIssue, assignIssue, createActor, createIssue, createLabel, getIssue, listActivity, openDb, claimIssue, updateIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

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
    expect(() => f.cli(["issue", "claim", issue.identifier, "--json"])).toThrow();
    expect(() => f.cli(["issue", "update", issue.identifier, "--title", "stale", "--expected-revision", "1", "--json"])).toThrow();
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
