import { expect, it } from "vitest";
import { createActor, createIssue, createProject, createTeam, updateProject } from "@issue-tracker/core";
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
