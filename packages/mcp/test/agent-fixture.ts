import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { applyMigrations, init, openDb, whoami, type ServiceContext } from "@issue-tracker/core";
import { createServer, type CreateServerOptions } from "../src/index.js";

export async function agentFixture(options: Partial<CreateServerOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tracker-agent-contract-"));
  const dbPath = join(directory, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date("2026-01-01T00:00:00Z") } };
  init(context);
  context.actor = whoami(context);
  const server = createServer({ dbPath, actor: { handle: context.actor.handle }, ...options });
  const client = new Client({ name: "agent-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    context, client, dbPath,
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      const block = (result.content as Array<{ type: string; text: string }>)[0]!;
      return { error: result.isError === true, data: JSON.parse(block.text) };
    },
    cli(args: string[]) {
      return execFileSync(process.execPath, [resolve("packages/cli/dist/index.js"), "--db", dbPath, ...args], { encoding: "utf8" });
    },
    async close() { await client.close(); await server.close(); db.$client.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}
