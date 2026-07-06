import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  getActor,
  init,
  listActors,
  openDb,
  serializeIssue,
  whoami,
  type Clock,
  type ServiceContext
} from "@issue-tracker/core";
import { createServer } from "../src/index.js";

const tempDirs: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("MCP server", () => {
  it("round-trips create_issue then get_issue through an in-process SDK client", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "build-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Set up CI",
        priority: 2
      });

      expect(created).toMatchObject({
        identifier: "ENG-1",
        title: "Set up CI",
        priority: 2
      });

      const fetched = await callJsonTool(client, "get_issue", {
        identifier: "ENG-1"
      });

      expect(fetched).toEqual(created);
    } finally {
      await client.close();
    }
  });

  it("returns byte-identical get_issue JSON to CLI issue view --json", async () => {
    const dbPath = initializedDbPath();
    const client = await connectClient(dbPath, { handle: "review-agent" });

    try {
      const created = await callJsonTool(client, "create_issue", {
        title: "Write parity test",
        description: "Compare MCP and CLI JSON",
        priority: 1
      });

      const fetched = await callJsonTool(client, "get_issue", {
        identifier: created.identifier
      });
      const cliOutput = tracker(dbPath, ["issue", "view", created.identifier, "--json"]);

      expect(`${JSON.stringify(fetched)}\n`).toBe(cliOutput);
    } finally {
      await client.close();
    }
  });

  it("auto-creates unknown MCP agent handles but never auto-creates humans", async () => {
    const dbPath = initializedDbPath();
    const agentClient = await connectClient(dbPath, { handle: "triage-agent" });

    try {
      await callJsonTool(agentClient, "create_issue", {
        title: "File agent finding"
      });
    } finally {
      await agentClient.close();
    }

    const { context, close } = openContext(dbPath);
    try {
      expect(getActor(context, "triage-agent")).toMatchObject({
        type: "agent",
        handle: "triage-agent",
        name: "triage-agent"
      });
    } finally {
      close();
    }

    const humanClient = await connectClient(dbPath, {
      handle: "new-human",
      type: "human"
    });

    try {
      const result = await humanClient.callTool({
        name: "create_issue",
        arguments: { title: "Should not create human actor" }
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Actor new-human was not found."
        }
      ]);
    } finally {
      await humanClient.close();
    }

    const after = openContext(dbPath);
    try {
      expect(listActors(after.context).map((actor) => actor.handle)).not.toContain("new-human");
    } finally {
      after.close();
    }
  });
});

async function connectClient(
  dbPath: string,
  actor: { handle: string; type?: "agent" | "human" }
) {
  const server = createServer({ dbPath, actor });
  const client = new Client({
    name: "issue-tracker-test",
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

function initializedDbPath(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-mcp-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "tracker.db");
  const { context, close } = openContext(dbPath);

  try {
    init(context);
    context.actor = whoami(context);
  } finally {
    close();
  }

  return dbPath;
}

function openContext(dbPath: string) {
  const db = openDb(dbPath);
  applyMigrations(db);

  const context: ServiceContext = {
    db,
    actor: null,
    clock: fixedClock("2026-01-01T00:00:00.000Z")
  };

  return {
    context,
    close: () => db.$client.close()
  };
}

function tracker(dbPath: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "packages/cli/src/index.ts", "--db", dbPath, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8"
    }
  );
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}
