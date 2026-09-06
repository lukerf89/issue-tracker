import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { agentFixture } from "./agent-fixture.js";

it("advertises registration-defined profiles while retaining aliases and normal coding calls", async () => {
  const full = await agentFixture();
  const coding = await agentFixture({ toolProfile: "coding" });
  const orchestration = await agentFixture({ toolProfile: "orchestration" });
  try {
    const all = (await full.client.listTools()).tools;
    const small = (await coding.client.listTools()).tools;
    expect(all.every((tool) => Array.isArray(tool._meta?.["issue-tracker/groups"]))).toBe(true);
    expect(small).toHaveLength(15);
    expect(small.map((tool) => tool.name)).toEqual(all.filter((tool) => (tool._meta?.["issue-tracker/groups"] as string[]).includes("coding")).map((tool) => tool.name));
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(Buffer.byteLength(JSON.stringify(all)) * 0.65);
    expect(small.map((tool) => tool.name)).not.toContain("get_current_actor");
    expect((await coding.call("get_current_actor", {})).data).toEqual((await coding.call("whoami", {})).data);
    const created = await coding.call("create_issue", { title: "Set up CI", response: "compact" });
    expect(created.error).toBe(false);
    const found = await coding.call("search", { query: "CI", limit: 1 });
    expect(found.data.issues[0].identifier).toBe(created.data.identifier);
    expect((await coding.call("claim_issue", { identifier: created.data.identifier })).error).toBe(false);
    expect((await coding.call("move_issue", { identifier: created.data.identifier, state: "In Progress", response: "compact" })).error).toBe(false);
    expect((await coding.call("comment_on_issue", { issue: created.data.identifier, body: "Verified" })).error).toBe(false);
    const orchestrated = (await orchestration.client.listTools()).tools.map((tool) => tool.name);
    expect(orchestrated).toContain("start_run");
    expect(orchestrated).toContain("get_issue");
    expect(orchestrated).not.toContain("create_team");
    // Native CLI stdio startup uses the same profile; this also exercises transport forwarding.
    const client = new Client({ name: "profile-cli-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("packages/cli/dist/index.js"), "--db", coding.dbPath, "mcp", "--agent", "build-agent", "--tool-profile", "coding"] }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(small.map((tool) => tool.name));
      const resources = await client.listResourceTemplates();
      expect(resources.resourceTemplates.length).toBeGreaterThan(0);
    } finally { await client.close(); }
  } finally { await full.close(); await coding.close(); await orchestration.close(); }
});
