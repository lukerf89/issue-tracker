import { expect, it } from "vitest";
import { createIssue, moveIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

const ids = (refs: Array<{ identifier: string }>) => refs.map((ref) => ref.identifier);

it("links related and follow-up issues through MCP and the CLI with identical results", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Ship fictional release" });
    createIssue(f.context, { title: "Tidy release notes" });
    createIssue(f.context, { title: "Audit release checklist" });
    moveIssue(f.context, "ENG-1", "Done");

    const created = await f.call("create_issue", { title: "Release retro", followUpOf: ["ENG-1"], related: ["ENG-2"] });
    expect(created.error).toBe(false);
    expect(ids(created.data.followUpOf)).toEqual(["ENG-1"]);
    expect(ids(created.data.related)).toEqual(["ENG-2"]);

    const updated = await f.call("update_issue", { identifier: "ENG-3", followUpOf: ["ENG-1"], related: ["ENG-2"] });
    expect(updated.error).toBe(false);
    expect(ids(updated.data.followUpOf)).toEqual(["ENG-1"]);

    // Same operation via the CLI against the same database.
    f.cli(["issue", "update", "ENG-2", "--related", "ENG-4", "--json"]);
    const viaCli = JSON.parse(f.cli(["issue", "view", "ENG-4", "--json"]));
    expect(ids(viaCli.related)).toEqual(["ENG-2"]);

    const done = await f.call("get_issue", { identifier: "ENG-1" });
    expect(ids(done.data.followUps)).toEqual(["ENG-3", "ENG-4"]);
    expect(done.data.followUpOf).toEqual([]);
    expect(JSON.parse(f.cli(["issue", "view", "ENG-1", "--json"]))).toEqual(done.data);

    const bounded = await f.call("get_issues", { identifiers: ["ENG-1", "ENG-2"], fields: ["related", "followUpOf", "followUps"] });
    expect(bounded.error).toBe(false);
    expect(ids(bounded.data.issues[0].data.followUps)).toEqual(["ENG-3", "ENG-4"]);
    expect(ids(bounded.data.issues[1].data.related)).toEqual(["ENG-3", "ENG-4"]);

    const listed = await f.call("list_issues", { followUpOf: "ENG-1", fields: ["followUpOf"] });
    expect(listed.data.issues.map((issue: { identifier: string }) => issue.identifier)).toEqual(["ENG-3", "ENG-4"]);
    const cliListed = JSON.parse(f.cli(["issue", "list", "--follow-up-of", "ENG-1", "--fields", "followUpOf", "--json"]));
    expect(cliListed.issues).toEqual(listed.data.issues);
    const related = await f.call("list_issues", { related: "ENG-2" });
    expect(related.data.issues.map((issue: { identifier: string }) => issue.identifier)).toEqual(["ENG-3", "ENG-4"]);

    const progress = await f.call("get_issue_progress", { identifier: "ENG-1" });
    expect(progress.data).toMatchObject({ unresolvedBlockers: 0, childCount: 0, remainingCriteria: 0, followUps: [{ identifier: "ENG-3" }, { identifier: "ENG-4" }] });

    const removed = await f.call("update_issue", { identifier: "ENG-3", removeFollowUpOf: ["ENG-1"], removeRelated: ["ENG-2"] });
    expect(removed.data.followUpOf).toEqual([]);
    expect(removed.data.related).toEqual([]);
    expect((await f.call("update_issue", { identifier: "ENG-3", related: ["ENG-3"] })).data.error.code).toBe("CONSTRAINT_VIOLATION");
    expect((await f.call("update_issue", { identifier: "ENG-3", related: ["ENG-2"], removeRelated: ["ENG-2"] })).error).toBe(true);
  } finally { await f.close(); }
});

it("renders relations in human CLI output without depending on color", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Ship fictional release" });
    createIssue(f.context, { title: "Tidy release notes", followUpOf: ["ENG-1"] });
    createIssue(f.context, { title: "Audit release checklist", related: ["ENG-1"] });
    // eslint-disable-next-line no-control-regex
    const text = f.cli(["issue", "view", "ENG-1"]).replace(/\u001b\[[0-9;]*m/g, "");
    expect(text).toContain("Related\n  ENG-3  Audit release checklist");
    expect(text).toContain("Follow-ups\n  ENG-2  Tidy release notes");
    // eslint-disable-next-line no-control-regex
    const followUp = f.cli(["issue", "view", "ENG-2"]).replace(/\u001b\[[0-9;]*m/g, "");
    expect(followUp).toContain("Follow-up of\n  ENG-1  Ship fictional release");
  } finally { await f.close(); }
});
