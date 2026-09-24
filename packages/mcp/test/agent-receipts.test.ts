import { expect, it } from "vitest";
import { addComment, archiveIssue, assignIssue, createIssue, createTemplate, listActivity, moveIssue, whoami } from "@issue-tracker/core";
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

it("reports no change for mutations that leave the issue as it was", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "CI" });
    moveIssue(f.context, "ENG-1", "In Progress");
    assignIssue(f.context, "ENG-1", whoami(f.context).id);
    const history = listActivity(f.context, { issue: "ENG-1" });
    for (const [tool, args] of [
      ["move_issue", { state: "In Progress" }],
      ["assign_issue", { actor: whoami(f.context).handle }]
    ] as const) {
      const result = await f.call(tool, { identifier: "ENG-1", ...args, response: "compact" });
      expect(result.data, tool).toMatchObject({ changed: false, changedFields: [] });
    }
    archiveIssue(f.context, "ENG-1");
    const archivedHistory = listActivity(f.context, { issue: "ENG-1" });
    const again = await f.call("archive_issue", { identifier: "ENG-1", response: "compact" });
    expect(again.data).toMatchObject({ changed: false, changedFields: [] });
    expect(listActivity(f.context, { issue: "ENG-1" })).toEqual(archivedHistory);
    expect(archivedHistory.length).toBe(history.length + 1);
  } finally { await f.close(); }
});

it("keeps the shared error envelope in compact mode and rejects unknown response modes", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "CI" });
    const missing = await f.call("update_issue", { identifier: "ENG-999", priority: 1, response: "compact" });
    expect(missing.error).toBe(true);
    expect(missing.data.error).toMatchObject({ code: "ISSUE_NOT_FOUND" });
    const tiny = await f.call("update_issue", { identifier: "ENG-1", priority: 1, response: "tiny" });
    expect(tiny.data.error.code).toBe("VALIDATION_FAILED");
    expect(f.cliError(["issue", "update", "ENG-1", "--priority", "1", "--response", "tiny", "--json"]).code).toBe("VALIDATION_FAILED");
  } finally { await f.close(); }
});

it("returns the same compact receipt shape from every CLI mutation", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "CI", description: "Large requirements. ".repeat(100) });
    createTemplate(f.context, { name: "bug", title: "Fix flaky build", team: "ENG" });
    const commands = [
      ["issue", "move", "ENG-1", "In Progress"],
      ["issue", "assign", "ENG-1", "--none"],
      ["issue", "archive", "ENG-1"],
      ["issue", "unarchive", "ENG-1"],
      ["issue", "create", "--template", "bug"]
    ];
    for (const command of commands) {
      const receipt = JSON.parse(f.cli([...command, "--response", "compact", "--json"]));
      expect(Object.keys(receipt).sort(), command.join(" ")).toEqual(["alreadyExisted", "changed", "changedFields", "identifier", "revision", "updatedAt"]);
    }
  } finally { await f.close(); }
});

it("rejects --response without --json before mutating", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "CI" });
    const history = listActivity(f.context, { issue: "ENG-1" });
    expect(f.cliError(["issue", "update", "ENG-1", "--priority", "2", "--response", "compact"]).message).toContain("--response requires --json");
    expect(listActivity(f.context, { issue: "ENG-1" })).toEqual(history);
  } finally { await f.close(); }
});
