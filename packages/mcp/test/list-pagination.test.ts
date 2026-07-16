import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createIssue,
  init,
  openDb,
  whoami,
  type Clock,
  type ServiceContext
} from "@issue-tracker/core";

import { createServer } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

interface IssuePagePayload {
  issues: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

describe("MCP list pagination + projection", () => {
  it("returns a compact summary that excludes bodies/nested data by default", async () => {
    const dbPath = seededDbPath(3);
    const client = await connectClient(dbPath);

    try {
      const page = (await callJsonTool(client, "list_issues", {})) as unknown as IssuePagePayload;

      expect(page.issues).toHaveLength(3);
      for (const issue of page.issues) {
        expect(Object.keys(issue).sort()).toEqual(
          ["assigneeId", "identifier", "priority", "stateId", "title", "updatedAt"].sort()
        );
        expect(issue).not.toHaveProperty("description");
        expect(issue).not.toHaveProperty("comments");
        expect(issue).not.toHaveProperty("attachments");
        expect(issue).not.toHaveProperty("labels");
      }
    } finally {
      await client.close();
    }
  });

  it("keeps a 50-issue default page comfortably small", async () => {
    const dbPath = seededDbPath(50);
    const client = await connectClient(dbPath);

    try {
      const page = (await callJsonTool(client, "list_issues", {})) as unknown as IssuePagePayload;

      expect(page.issues).toHaveLength(50);
      // A full-fidelity dump of this fixture overflowed the MCP token cap in the wild;
      // the compact page must stay small. ~120 bytes/issue keeps 50 well under any cap.
      const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
      expect(bytes).toBeLessThan(12_000);
    } finally {
      await client.close();
    }
  });

  it("paginates deterministically with a stable cursor contract", async () => {
    const dbPath = seededDbPath(25);
    const client = await connectClient(dbPath);

    try {
      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let pages = 0;

      do {
        const args: Record<string, unknown> = { limit: 10 };
        if (cursor) {
          args.cursor = cursor;
        }
        const page = (await callJsonTool(client, "list_issues", args)) as unknown as IssuePagePayload;
        pages += 1;
        for (const issue of page.issues) {
          seen.push(issue.identifier as string);
        }
        cursor = page.nextCursor;
      } while (cursor);

      expect(pages).toBe(3); // 10 + 10 + 5
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25); // no dupes, no gaps

      const expected = Array.from({ length: 25 }, (_, index) => `ENG-${index + 1}`).sort();
      expect([...seen].sort()).toEqual(expected);
    } finally {
      await client.close();
    }
  });

  it("projects opt-in fields and rejects unknown field names", async () => {
    const dbPath = seededDbPath(1);
    const client = await connectClient(dbPath);

    try {
      const page = (await callJsonTool(client, "list_issues", {
        fields: ["description", "labels"]
      })) as unknown as IssuePagePayload;

      expect(page.issues[0]).toHaveProperty("description");
      expect(page.issues[0]).toHaveProperty("labels");
      expect(page.issues[0]).not.toHaveProperty("comments");

      const rejected = await client.callTool({
        name: "list_issues",
        arguments: { fields: ["comments"] }
      });
      expect(rejected.isError).toBe(true);
      const [errorContent] = rejected.content as Array<{ type: string; text?: string }>;
      expect(errorContent?.text).toContain("VALIDATION_FAILED");
    } finally {
      await client.close();
    }
  });

  it("still returns full fidelity through get_issue", async () => {
    const dbPath = seededDbPath(1);
    const client = await connectClient(dbPath);

    try {
      const full = await callJsonTool(client, "get_issue", { identifier: "ENG-1" });

      expect(full).toHaveProperty("description");
      expect(full).toHaveProperty("comments");
      expect(full).toHaveProperty("attachments");
      expect(full).toHaveProperty("labels");
    } finally {
      await client.close();
    }
  });
});

function seededDbPath(count: number): string {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-pagination-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "tracker.db");
  const { context, close } = openContext(dbPath);

  try {
    init(context);
    context.actor = whoami(context);
    for (let index = 0; index < count; index += 1) {
      createIssue(context, { title: `Issue ${index + 1}` });
    }
  } finally {
    close();
  }

  return dbPath;
}

async function connectClient(dbPath: string) {
  const server = createServer({ dbPath, actor: { handle: "pagination-agent" } });
  const client = new Client({ name: "pagination-test", version: "0.0.0" });
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
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as Array<{ type: string; text?: string }>;

  if (!content || content.type !== "text" || typeof content.text !== "string") {
    throw new Error(`Tool ${name} did not return JSON text content.`);
  }

  return JSON.parse(content.text) as Record<string, unknown>;
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

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}
