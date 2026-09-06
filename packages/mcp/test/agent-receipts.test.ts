import { expect, it } from "vitest";
import { addComment, createIssue, listActivity } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

it("returns bounded accurate mutation receipts and preserves full reads", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "CI", description: "Large requirements. ".repeat(3000) });
    addComment(f.context, { issue: "ENG-1", body: "Long discussion. ".repeat(3000) });
    const response = await f.call("update_issue", { identifier: "ENG-1", priority: 2, response: "compact" });
    expect(response.error).toBe(false);
    expect(response.data.changedFields).toEqual(["priority"]);
    expect(response.data.changed).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response.data))).toBeLessThan(500);
    const history = listActivity(f.context, { issue: "ENG-1" });
    const noOp = JSON.parse(f.cli(["issue", "update", "ENG-1", "--priority", "2", "--response", "compact", "--json"]));
    expect(noOp).toMatchObject({ changed: false, changedFields: [], revision: response.data.revision });
    expect(listActivity(f.context, { issue: "ENG-1" })).toEqual(history);
    for (const [tool, args] of [
      ["move_issue", { state: "In Progress" }], ["assign_issue", { actor: null }],
      ["archive_issue", {}], ["unarchive_issue", {}]
    ] as const) {
      const result = await f.call(tool, { identifier: "ENG-1", ...args, response: "compact" });
      expect(result.error).toBe(false);
      expect(result.data).not.toHaveProperty("description");
      expect(result.data).toHaveProperty("changedFields");
    }
    const full = await f.call("update_issue", { identifier: "ENG-1", priority: 3, response: "full" });
    expect(full.data.description.length).toBeGreaterThan(50_000);
    expect(full.data.comments).toHaveLength(1);
    expect(full.data).not.toHaveProperty("mutationReceipt");
    const created = await f.call("create_issue", { title: "Build", response: "compact", idempotencyKey: "build" });
    const replay = await f.call("create_issue", { title: "Build", response: "compact", idempotencyKey: "build" });
    expect(created.data.changed).toBe(true);
    expect(replay.data).toMatchObject({ identifier: created.data.identifier, changed: false, changedFields: [], alreadyExisted: true });
    const cliCreated = JSON.parse(f.cli(["issue", "create", "--title", "Test", "--response", "compact", "--json"]));
    expect(cliCreated.changed).toBe(true);
    expect(cliCreated).not.toHaveProperty("description");
  } finally { await f.close(); }
});

it("preserves UUID references accepted by assignment and archival", async () => {
  const f = await agentFixture();
  try {
    const issue = createIssue(f.context, { title: "CI" });
    for (const [name, args] of [["assign_issue", { actor: null }], ["archive_issue", {}], ["unarchive_issue", {}]] as const) {
      const result = await f.call(name, { identifier: issue.id, ...args, response: "compact" });
      expect(result.error).toBe(false);
      expect(result.data.identifier).toBe(issue.identifier);
    }
  } finally { await f.close(); }
});
