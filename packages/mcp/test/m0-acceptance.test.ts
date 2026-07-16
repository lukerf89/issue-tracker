import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";

const tempDirs: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("M0 acceptance", () => {
  it("runs init to issue creation and reads the moved issue back over MCP", async () => {
    const dbPath = tempDbPath();

    const initialized = trackerJson(dbPath, [
      "init",
      "--workspace",
      "Fictional Workspace",
      "--team-key",
      "ENG",
      "--team-name",
      "Engineering",
      "--actor-name",
      "Human Owner",
      "--actor-handle",
      "owner",
      "--json"
    ]);
    expect(initialized).toMatchObject({
      workspace: { name: "Fictional Workspace" },
      team: { key: "ENG", name: "Engineering", issueCounter: 0, archivedAt: null },
      actor: { type: "human", name: "Human Owner", handle: "owner", archivedAt: null }
    });

    const project = trackerJson(dbPath, [
      "project",
      "create",
      "Platform Foundations",
      "--status",
      "planned",
      "--json"
    ]);
    expect(project).toMatchObject({
      name: "Platform Foundations",
      description: null,
      status: "planned",
      leadId: null,
      startDate: null,
      targetDate: null,
      archivedAt: null
    });

    const created = trackerJson(dbPath, [
      "issue",
      "create",
      "--title",
      "Set up CI",
      "--project",
      "Platform Foundations",
      "--priority",
      "2",
      "--json"
    ]);
    expect(created).toMatchObject({
      identifier: "ENG-1",
      number: 1,
      title: "Set up CI",
      description: null,
      priority: 2,
      assigneeId: null,
      projectId: project.id,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null
    });

    const listed = trackerJson(dbPath, ["issue", "list", "--json"]) as {
      issues: Array<{ identifier: string }>;
      nextCursor: string | null;
    };
    expect(listed.nextCursor).toBeNull();
    expect(listed.issues.map((issue) => issue.identifier)).toEqual([created.identifier]);

    const started = trackerJson(dbPath, ["issue", "move", "ENG-1", "In Progress", "--json"]);
    expect(started).toMatchObject({
      identifier: "ENG-1",
      stateId: expect.any(String),
      startedAt: expect.any(String),
      completedAt: null,
      canceledAt: null
    });

    const completed = trackerJson(dbPath, ["issue", "move", "ENG-1", "Done", "--json"]);
    expect(completed).toMatchObject({
      identifier: "ENG-1",
      startedAt: started.startedAt,
      completedAt: expect.any(String),
      canceledAt: null
    });

    const cliIssue = trackerJson(dbPath, ["issue", "view", "ENG-1", "--json"]);
    expect(cliIssue).toEqual(completed);

    const client = await connectClient(dbPath);
    try {
      const mcpIssue = await callJsonTool(client, "get_issue", { identifier: "ENG-1" });
      expect(mcpIssue).toEqual(cliIssue);
    } finally {
      await client.close();
    }
  });
});

function tempDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-m0-"));
  tempDirs.push(tempDir);
  return join(tempDir, "tracker.db");
}

function trackerJson(dbPath: string, args: string[]): Record<string, unknown> | Array<Record<string, unknown>> {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/index.ts", "--db", dbPath, ...args],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    )
  ) as Record<string, unknown> | Array<Record<string, unknown>>;
}

async function connectClient(dbPath: string) {
  const server = createServer({
    dbPath,
    actor: {
      type: "agent",
      handle: "acceptance-agent"
    }
  });
  const client = new Client({
    name: "issue-tracker-m0-acceptance",
    version: "0.0.0"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

async function callJsonTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name,
    arguments: args
  });
  const [content] = result.content;

  if (!content || content.type !== "text") {
    throw new Error(`Tool ${name} did not return JSON text content.`);
  }

  return JSON.parse(content.text) as Record<string, unknown>;
}
