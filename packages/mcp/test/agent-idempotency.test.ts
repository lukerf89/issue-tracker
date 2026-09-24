import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createIssue, getIssue, listActivity } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

const builtCliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/index.js");
const run = promisify(execFile);

it("replays comment_on_issue and link_issue by idempotencyKey through the strict schemas", async () => {
  const f = await agentFixture();
  try {
    const issue = createIssue(f.context, { title: "Set up CI" });

    const comment = { issue: issue.identifier, body: "Pipeline is green.", idempotencyKey: "mcp-comment-1" };
    const firstComment = await f.call("comment_on_issue", comment);
    expect(firstComment.error).toBe(false);
    expect(firstComment.data.alreadyExisted).toBe(false);
    const revision = getIssue(f.context, issue.identifier).revision;
    const activity = listActivity(f.context, { issue: issue.identifier });

    const replayComment = await f.call("comment_on_issue", { ...comment, expectedRevision: issue.revision });
    expect(replayComment.data).toEqual({ ...firstComment.data, alreadyExisted: true });

    const link = { issue: issue.identifier, kind: "link", url: "https://example.invalid/ci", idempotencyKey: "mcp-link-1" };
    const firstLink = await f.call("link_issue", link);
    expect(firstLink.data.alreadyExisted).toBe(false);
    const replayLink = await f.call("link_issue", link);
    expect(replayLink.data).toEqual({ ...firstLink.data, alreadyExisted: true });
    // Only the fresh link wrote: one revision bump and one activity row since the comment.
    expect(getIssue(f.context, issue.identifier).revision).toBe(revision + 1);
    expect(listActivity(f.context, { issue: issue.identifier })).toHaveLength(activity.length + 1);

    const conflict = await f.call("comment_on_issue", { ...comment, body: "Different" });
    expect(conflict.error).toBe(true);
    expect(conflict.data).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message: expect.any(String),
        details: {
          resource: "comment",
          idempotencyKey: "mcp-comment-1",
          existingId: firstComment.data.id,
          issueIdentifier: issue.identifier,
          mismatchedFields: ["body"]
        }
      }
    });
  } finally { await f.close(); }
});

it("returns identical CLI --json and MCP payloads for the same replay", async () => {
  const f = await agentFixture();
  try {
    const issue = createIssue(f.context, { title: "Set up CI" });
    const mcpFirst = await f.call("comment_on_issue", { issue: issue.identifier, body: "Parity", idempotencyKey: "parity-c" });
    const cliReplay = JSON.parse(f.cli(["issue", "comment", issue.identifier, "Parity", "--idempotency-key", "parity-c", "--json"]));
    const mcpReplay = await f.call("comment_on_issue", { issue: issue.identifier, body: "Parity", idempotencyKey: "parity-c" });
    expect(cliReplay).toEqual(mcpReplay.data);
    expect(cliReplay).toEqual({ ...mcpFirst.data, alreadyExisted: true });

    const linkFirst = JSON.parse(f.cli(["issue", "link", issue.identifier, "--kind", "branch", "--repo", "/repos/app", "--branch", "feature/ci", "--idempotency-key", "parity-l", "--json"]));
    const linkReplay = await f.call("link_issue", { issue: issue.identifier, kind: "branch", repoPath: "/repos/app", branchName: "feature/ci", idempotencyKey: "parity-l" });
    expect(linkReplay.data).toEqual({ ...linkFirst, alreadyExisted: true });
    expect(f.cliError(["issue", "link", issue.identifier, "--kind", "branch", "--repo", "/repos/app", "--branch", "feature/other", "--idempotency-key", "parity-l", "--json"]).code)
      .toBe("IDEMPOTENCY_KEY_CONFLICT");
  } finally { await f.close(); }
});

describe.each([
  { command: "comment", action: "commented", args: (body: string) => ["issue", "comment", "ENG-1", body] },
  { command: "link", action: "linked", args: (body: string) => ["issue", "link", "ENG-1", `https://example.invalid/${body}`] }
])("simultaneous keyed `issue $command` processes", ({ command, action, args }) => {
  it("same payload: both succeed, exactly one writes", async () => {
    const f = await agentFixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const cliArgs = [builtCliPath, "--db", f.dbPath, ...args("same"), "--idempotency-key", `race-${command}`, "--json"];
      const results = await Promise.all([run(process.execPath, cliArgs), run(process.execPath, cliArgs)]);
      const payloads = results.map((result) => JSON.parse(result.stdout) as { id: string; alreadyExisted: boolean });
      expect(payloads.map((payload) => payload.alreadyExisted).sort()).toEqual([false, true]);
      expect(payloads[0]!.id).toBe(payloads[1]!.id);
      expect(listActivity(f.context, { issue: "ENG-1" }).filter((entry) => entry.action === action)).toHaveLength(1);
      expect(getIssue(f.context, "ENG-1").revision).toBe(issue.revision + 1);
      const view = JSON.parse(f.cli(["issue", "view", "ENG-1", "--json"])) as { comments: unknown[]; attachments: unknown[] };
      expect(command === "comment" ? view.comments : view.attachments).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("different payloads: one succeeds, one conflicts, no partial write", async () => {
    const f = await agentFixture();
    try {
      const issue = createIssue(f.context, { title: "Set up CI" });
      const key = ["--idempotency-key", `race-diff-${command}`, "--json"];
      const results = await Promise.allSettled([
        run(process.execPath, [builtCliPath, "--db", f.dbPath, ...args("first"), ...key]),
        run(process.execPath, [builtCliPath, "--db", f.dbPath, ...args("second"), ...key])
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(String(rejected?.status === "rejected" ? rejected.reason.stderr : "")).toContain("IDEMPOTENCY_KEY_CONFLICT");
      expect(listActivity(f.context, { issue: "ENG-1" }).filter((entry) => entry.action === action)).toHaveLength(1);
      expect(getIssue(f.context, "ENG-1").revision).toBe(issue.revision + 1);
      const view = JSON.parse(f.cli(["issue", "view", "ENG-1", "--json"])) as { comments: unknown[]; attachments: unknown[] };
      expect(command === "comment" ? view.comments : view.attachments).toHaveLength(1);
    } finally { await f.close(); }
  });
});
