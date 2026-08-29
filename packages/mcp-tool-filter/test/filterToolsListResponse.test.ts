import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { applyMigrations, openDb } from "@issue-tracker/core";
import { createServer } from "@issue-tracker/mcp";
import { afterEach, describe, expect, it } from "vitest";

import { filterToolsListResponse } from "../src/filterToolsListResponse.js";
import { ORCHESTRATION_TOOL_NAME_SET } from "../src/orchestrationTools.js";

const tempDirs: string[] = [];

// Hardcoded snapshot of every MCP tool that is NOT run-orchestration surface,
// i.e. the tools a manual chat review session actually uses. Kept in sync
// with packages/mcp/src/tools/{actors,metadata,issues,labels,projects,teams,cycles}.ts.
// If this list and ORCHESTRATION_TOOL_NAME_SET together stop covering every
// tool the live server registers, the drift-guard test below fails.
const EXPECTED_RETAINED_TOOL_NAMES = [
  "whoami",
  "get_current_actor",
  "create_actor",
  "list_actors",
  "describe",
  "list_states",
  "list_issues",
  "search",
  "get_issue",
  "list_activity",
  "create_issue",
  "update_issue",
  "move_issue",
  "assign_issue",
  "archive_issue",
  "unarchive_issue",
  "comment_on_issue",
  "link_issue",
  "create_label",
  "list_labels",
  "archive_label",
  "unarchive_label",
  "list_projects",
  "get_project",
  "create_project",
  "update_project",
  "archive_project",
  "unarchive_project",
  "create_team",
  "list_teams",
  "archive_team",
  "unarchive_team",
  "create_cycle",
  "list_cycles"
];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("filterToolsListResponse", () => {
  it("strips run-orchestration tools from a tools/list response, preserving order and other fields", () => {
    const message = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "get_issue", description: "Read one issue." },
          { name: "preview_run", description: "Resolve a run without mutation." },
          { name: "list_teams", description: "List teams." },
          { name: "start_run", description: "Persist a run." }
        ],
        nextCursor: undefined
      }
    } as unknown as JSONRPCMessage;

    const filtered = filterToolsListResponse(message) as unknown as {
      jsonrpc: string;
      id: number;
      result: { tools: Array<{ name: string }> };
    };

    expect(filtered.jsonrpc).toBe("2.0");
    expect(filtered.id).toBe(1);
    expect(filtered.result.tools.map((tool) => tool.name)).toEqual(["get_issue", "list_teams"]);
  });

  it("returns non-tools/list messages unchanged (identity passthrough)", () => {
    const request = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} }
    } as unknown as JSONRPCMessage;

    expect(filterToolsListResponse(request)).toBe(request);

    const callResult = {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "{}" }] }
    } as unknown as JSONRPCMessage;

    expect(filterToolsListResponse(callResult)).toBe(callResult);

    const notification = {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    } as unknown as JSONRPCMessage;

    expect(filterToolsListResponse(notification)).toBe(notification);
  });

  it("returns the same message reference when nothing needed stripping", () => {
    const message = {
      jsonrpc: "2.0",
      id: 4,
      result: { tools: [{ name: "get_issue" }] }
    } as unknown as JSONRPCMessage;

    expect(filterToolsListResponse(message)).toBe(message);
  });

  it("drift guard: live server's tool set matches the expected retained + orchestration split exactly", async () => {
    const dbPath = initializedDbPath();
    const server = createServer({ dbPath, actor: { handle: "drift-guard-agent", type: "agent" } });
    const client = new Client({ name: "drift-guard", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const liveNames = new Set(tools.map((tool) => tool.name));

    // Every stripped name must still exist on the live server (catches a
    // rename/removal in packages/mcp without updating this filter list).
    for (const name of ORCHESTRATION_TOOL_NAME_SET) {
      expect(liveNames.has(name), `expected live server to still register "${name}"`).toBe(true);
    }

    // The live server's non-orchestration tool names must match this
    // hardcoded expected list exactly (not merely "not in the orchestration
    // set", which would be tautological). This fails loudly if packages/mcp
    // adds a brand-new orchestration tool that this package hasn't been told
    // to strip yet, or renames/removes a retained tool.
    const retainedNames = [...liveNames].filter((name) => !ORCHESTRATION_TOOL_NAME_SET.has(name));

    expect(new Set(retainedNames)).toEqual(new Set(EXPECTED_RETAINED_TOOL_NAMES));
    expect(liveNames.size).toBe(
      ORCHESTRATION_TOOL_NAME_SET.size + EXPECTED_RETAINED_TOOL_NAMES.length
    );
  });

  it("filtering the live server's real tools/list response yields exactly the retained set", async () => {
    const dbPath = initializedDbPath();
    const server = createServer({ dbPath, actor: { handle: "drift-guard-agent", type: "agent" } });
    const client = new Client({ name: "drift-guard-filter", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const rawResult = await client.listTools();
    const syntheticResponse = {
      jsonrpc: "2.0",
      id: 99,
      result: rawResult
    } as unknown as JSONRPCMessage;

    const filtered = filterToolsListResponse(syntheticResponse) as unknown as {
      result: { tools: Array<{ name: string }> };
    };
    const filteredNames = new Set(filtered.result.tools.map((tool) => tool.name));

    for (const name of filteredNames) {
      expect(ORCHESTRATION_TOOL_NAME_SET.has(name)).toBe(false);
    }

    expect(filteredNames).toEqual(new Set(EXPECTED_RETAINED_TOOL_NAMES));
  });
});

function initializedDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "mcp-tool-filter-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);
  db.$client.close();

  return dbPath;
}
