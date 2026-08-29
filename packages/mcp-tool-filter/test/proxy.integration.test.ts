import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { ORCHESTRATION_TOOL_NAME_SET } from "../src/orchestrationTools.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliEntry = resolve(repoRoot, "packages/cli/dist/index.js");
const proxyEntry = resolve(repoRoot, "packages/mcp-tool-filter/src/index.ts");

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("mcp-tool-filter proxy (real subprocess)", () => {
  it("advertises only the non-orchestration tools via tools/list, and still executes a retained tool call end-to-end", async () => {
    const dbPath = initializedDbPath();
    const client = await connectThroughProxy(dbPath);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    for (const name of names) {
      expect(
        ORCHESTRATION_TOOL_NAME_SET.has(name),
        `unexpected orchestration tool "${name}" leaked through`
      ).toBe(false);
    }
    expect(names).toContain("whoami");
    expect(names).toContain("get_issue");
    expect(names.length).toBeGreaterThan(0);

    // Actual tool calls (not just tools/list) must still round-trip
    // through the proxy untouched.
    const result = await client.callTool({ name: "whoami", arguments: {} });
    const [content] = result.content as Array<{ type: string; text?: string }>;
    expect(content?.type).toBe("text");
    const actor = JSON.parse(content?.text ?? "{}") as { handle: string };
    expect(actor.handle).toBe("proxy-integration-agent");
  }, 120000);
});

async function connectThroughProxy(dbPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      proxyEntry,
      "--db",
      dbPath,
      "mcp",
      "--agent",
      "proxy-integration-agent"
    ],
    cwd: repoRoot,
    env: { ...process.env, TRACKER_CLI_ENTRY: cliEntry }
  });

  const client = new Client({ name: "proxy-integration-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);

  return client;
}
function initializedDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-tool-filter-proxy-"));
  tempDirs.push(tempDir);

  return join(tempDir, "tracker.db");
}
