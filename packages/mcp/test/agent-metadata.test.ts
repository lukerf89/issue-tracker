import { expect, it } from "vitest";
import { archiveProject, archiveTeam, createActor, createIssue, createProject, createTeam, getTeamByKey, updateProject } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

it("scopes metadata, fingerprints selected content and projects readable references", async () => {
  const f = await agentFixture();
  try {
    createTeam(f.context, { key: "OPS", name: "Operations" });
    const project = createProject(f.context, { name: "Build", description: "Large context. ".repeat(5000) });
    const actor = createActor(f.context, { handle: "build-agent", name: "Build", type: "agent" });
    createIssue(f.context, { title: "CI", assignee: actor.handle });
    const scoped = await f.call("describe", { team: "OPS", sections: ["teams", "priorities"], compact: true });
    expect(scoped.data.teams).toHaveLength(1);
    expect(scoped.data.teams[0].key).toBe("OPS");
    expect(scoped.data).not.toHaveProperty("projects");
    expect(JSON.parse(f.cli(["describe", "--team", "OPS", "--sections", "teams,priorities", "--compact", "--json"]))).toEqual(scoped.data);
    const compact = await f.call("describe", { sections: ["projects"], compact: true });
    expect(Buffer.byteLength(JSON.stringify(compact.data))).toBeLessThan(1000);
    updateProject(f.context, project.id, { description: "Different body" });
    expect((await f.call("describe", { sections: ["projects"], compact: true })).data.metadataRevision).toBe(compact.data.metadataRevision);
    updateProject(f.context, project.id, { name: "Build tools" });
    expect((await f.call("describe", { sections: ["projects"], compact: true })).data.metadataRevision).not.toBe(compact.data.metadataRevision);
    const fields = ["stateName", "stateType", "assigneeHandle", "revision"];
    const page = await f.call("list_issues", { fields });
    expect(page.data.issues[0]).toMatchObject({ stateName: "Todo", stateType: "unstarted", assigneeHandle: "build-agent", revision: 1 });
    expect(JSON.parse(f.cli(["issue", "list", "--fields", fields.join(","), "--json"]))).toEqual(page.data);
    f.context.db.run("update actors set archived_at = '2026-01-02T00:00:00Z' where handle = 'build-agent'");
    expect((await f.call("search", { query: "CI", fields })).data.issues[0].assigneeHandle).toBe("build-agent");
    createIssue(f.context, { title: "Unassigned", team: "OPS" });
    expect((await f.call("list_issues", { team: "OPS", fields })).data.issues[0].assigneeHandle).toBe(null);
    expect((await f.call("describe", { team: "missing" })).error).toBe(true);
  } finally { await f.close(); }
});

it("keeps same-named states scoped to their own team", async () => {
  const f = await agentFixture();
  try {
    const ops = createTeam(f.context, { key: "OPS", name: "Operations" });
    const eng = getTeamByKey(f.context, "ENG");
    // Both teams seed a "Todo" state. Rename OPS's so a lookup through the wrong team shows.
    f.context.db.$client.prepare("update workflow_states set name = 'Queued' where team_id = ? and name = 'Todo'").run(ops.id);
    createIssue(f.context, { title: "CI" });
    createIssue(f.context, { title: "Pager rota", team: "OPS" });

    const scoped = await f.call("describe", { team: "OPS", sections: ["teams"] });
    const states = scoped.data.teams[0].states as Array<{ teamId: string; name: string }>;
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state.teamId === ops.id)).toBe(true);
    expect(states.map((state) => state.name)).toContain("Queued");
    expect(states.some((state) => state.teamId === eng.id)).toBe(false);

    const fields = ["stateName", "stateType"];
    const byTeam = async (team: string) => (await f.call("list_issues", { team, fields })).data.issues[0];
    expect(await byTeam("OPS")).toMatchObject({ identifier: "OPS-1", stateName: "Queued", stateType: "unstarted" });
    expect(await byTeam("ENG")).toMatchObject({ identifier: "ENG-1", stateName: "Todo", stateType: "unstarted" });
  } finally { await f.close(); }
});

it("hides archived teams and projects from discovery, scoped or not", async () => {
  const f = await agentFixture();
  try {
    createTeam(f.context, { key: "OPS", name: "Operations" });
    createProject(f.context, { name: "Legacy" });
    archiveTeam(f.context, "OPS");
    archiveProject(f.context, "Legacy");
    const all = await f.call("describe", { sections: ["teams", "projects"], compact: true });
    expect(all.data.teams.map((team: { key: string }) => team.key)).toEqual(["ENG"]);
    expect(all.data.projects).toEqual([]);
    const scoped = await f.call("describe", { team: "OPS" });
    expect(scoped.data.error.code).toBe("TEAM_NOT_FOUND");
  } finally { await f.close(); }
});

it("rejects an empty section list and scopes CLI discovery by either --team position", async () => {
  const f = await agentFixture();
  try {
    createTeam(f.context, { key: "OPS", name: "Operations" });
    expect((await f.call("describe", { sections: [] })).data.error.code).toBe("VALIDATION_FAILED");
    const keys = (args: string[]) => JSON.parse(f.cli(args)).teams.map((team: { key: string }) => team.key).sort();
    expect(keys(["describe", "--sections", "teams", "--json"])).toEqual(["ENG", "OPS"]);
    expect(keys(["--team", "OPS", "describe", "--sections", "teams", "--json"])).toEqual(["OPS"]);
    expect(keys(["describe", "--team", "OPS", "--sections", "teams", "--json"])).toEqual(["OPS"]);
  } finally { await f.close(); }
});
