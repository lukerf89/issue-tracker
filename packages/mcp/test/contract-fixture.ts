import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  addComment, addAttachment, addProfile, addRepository, applyMigrations, assignIssue, associateRepository, builtinProfileInput,
  createIssue, createLabel, createNodeRepositoryInspector, createProject, createSavedView, createTeam, createTemplate, init, openDb,
  previewRun, startRun, whoami, type Clock, type ServiceContext, type ToolProfile
} from "@issue-tracker/core";

import { createServer } from "../src/index.js";
import { seedWorkload, type Workload } from "./workload-seed.js";

const builtCliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/index.js");

/** A clock that moves forward one second on every read, so any re-stamp on a repeat call is visible. */
export function advancingClock(start = "2026-02-01T00:00:00.000Z"): Clock {
  let at = Date.parse(start);
  return { now: () => new Date((at += 1000)) };
}

export interface ToolCall {
  isError: boolean;
  text: string;
  data: unknown;
  structuredContent: Record<string, unknown> | undefined;
}

type RawDb = ReturnType<typeof openDb>["$client"];
type Snapshot = Record<string, string[]>;
export interface AuditEntry { table: string; op: "UPDATE" | "DELETE"; changed: string[] }

export interface ContractFixtureOptions {
  /** Also seed the heavy LF-145 workload (long bodies/comments, many relations, run events). */
  workload?: boolean;
}

/**
 * Seeded fictional workspace for contract tests: every entity kind the tool catalog touches, two
 * MCP clients on the same database (a reader whose agent handle is absent from the database and a
 * writer), an advancing clock, and full-content snapshots plus an UPDATE/DELETE audit trail.
 * Every client's server-to-client JSON-RPC bytes are counted (observation only).
 */
export async function contractFixture(options: ContractFixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tracker-tool-contracts-"));
  const previousEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  process.env.XDG_CONFIG_HOME = join(directory, "config");
  process.env.XDG_DATA_HOME = join(directory, "data");
  const engineConfig = join(directory, "config", "issue-tracker", "engines.json");
  mkdirSync(dirname(engineConfig), { recursive: true });
  writeFileSync(engineConfig, JSON.stringify({
    schemaVersion: 1,
    engines: { "claude-default": { adapter: "fake", executable: process.execPath, model: "fictional-model" } }
  }));

  const dbPath = join(directory, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } };
  init(context);
  context.actor = whoami(context);
  const seed = seedWorkspace(context, directory);
  const workload: Workload | undefined = options.workload ? seedWorkload(context, seed.run) : undefined;

  const clock = advancingClock();
  const servers: Array<{ server: { close(): Promise<void> }; client: Client }> = [];
  const wireBytes = new WeakMap<Client, { bytes: number }>();
  const connect = async (actor: string | { handle: string; type?: "agent" | "human" }, connectOptions: { toolProfile?: ToolProfile } = {}) => {
    const server = createServer({ dbPath, actor: typeof actor === "string" ? { handle: actor } : actor, clock, toolProfile: connectOptions.toolProfile });
    const client = new Client({ name: "tool-contract-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Count every JSON-RPC message the server sends this client (the envelope as serialized;
    // the in-memory transport has no stdio framing, so stdio's newline per message is excluded).
    const counter = { bytes: 0 };
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, sendOptions) => {
      counter.bytes += Buffer.byteLength(JSON.stringify(message));
      return send(message, sendOptions);
    };
    wireBytes.set(client, counter);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    servers.push({ server, client });
    return { server, client };
  };
  const reader = await connect("fictional-unknown-reader");
  const writer = await connect("fictional-agent");
  const raw = openDb(dbPath).$client;
  installAuditTriggers(raw);

  const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolCall> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    return {
      isError: result.isError === true,
      text,
      data: JSON.parse(text),
      structuredContent: result.structuredContent as Record<string, unknown> | undefined
    };
  };

  return {
    directory, dbPath, context, seed, engineConfig,
    /** The heavy workload's seeded content (only with `{ workload: true }`). */
    workload,
    reader: reader.client,
    writer: writer.client,
    read: (name: string, args: Record<string, unknown>) => call(reader.client, name, args),
    write: (name: string, args: Record<string, unknown>) => call(writer.client, name, args),
    call,
    /** Another client on the same database and clock, as the given caller (closed with the fixture). */
    connect: async (actor: { handle: string; type?: "agent" | "human" }, connectOptions: { toolProfile?: ToolProfile } = {}) =>
      (await connect(actor, connectOptions)).client,
    /** Server-to-client JSON-RPC bytes this client has received since connecting (or the last reset). */
    jsonRpcBytes: (client: Client) => wireBytes.get(client)?.bytes ?? 0,
    resetJsonRpcBytes: (client: Client) => { const counter = wireBytes.get(client); if (counter) counter.bytes = 0; },
    /** Every table's content (order-insensitive), excluding FTS internals and test bookkeeping. */
    snapshot(): Snapshot {
      const snapshot: Snapshot = {};
      for (const table of userTables(raw)) {
        snapshot[table] = (raw.prepare(`SELECT * FROM "${table}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort();
      }
      return snapshot;
    },
    /** UPDATE/DELETE statements recorded by the audit triggers since the last drain. */
    drainAudit(): AuditEntry[] {
      const rows = raw.prepare("SELECT tbl, op, changed FROM __contract_audit ORDER BY seq").all() as Array<{ tbl: string; op: "UPDATE" | "DELETE"; changed: string }>;
      raw.prepare("DELETE FROM __contract_audit").run();
      return rows.map((row) => ({ table: row.tbl, op: row.op, changed: row.changed.split(",").filter(Boolean) }));
    },
    actorHandles(): string[] {
      return (raw.prepare("SELECT handle FROM actors ORDER BY handle").all() as Array<{ handle: string }>).map((row) => row.handle);
    },
    cli(args: string[]): string {
      return execFileSync(process.execPath, [builtCliPath, "--db", dbPath, ...args], {
        encoding: "utf8", stdio: "pipe", env: { ...process.env, NO_COLOR: "1" }
      });
    },
    cliError(args: string[]): unknown {
      try {
        execFileSync(process.execPath, [builtCliPath, "--db", dbPath, ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, NO_COLOR: "1" } });
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        return JSON.parse(stderr.trim().split("\n").at(-1)!);
      }
      throw new Error(`expected CLI command to fail: ${args.join(" ")}`);
    },
    async close() {
      for (const { client, server } of servers) { await client.close(); await server.close(); }
      raw.close();
      db.$client.close();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

export type ContractFixture = Awaited<ReturnType<typeof contractFixture>>;

function gitRepository(root: string, name: string): string {
  const repository = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repository]);
  writeFileSync(join(repository, "README.md"), `# Fictional ${name}\n`);
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fictional User", "-c", "user.email=fictional@example.test", "commit", "-q", "-m", "Set up fictional repository"]);
  return repository;
}

const commands = {
  testCommand: { executable: "node", args: ["--test"], envNames: [] },
  verificationCommand: { executable: "npm", args: ["run", "typecheck"], envNames: [] }
};

function seedWorkspace(context: ServiceContext, root: string) {
  const human = whoami(context);
  const delivery = createProject(context, { name: "Fictional Delivery" });
  createProject(context, { name: "Fictional Archive" });
  createLabel(context, { name: "Bug" });
  createLabel(context, { name: "Feature" });
  const ci = createIssue(context, { title: "Set up CI", description: "Wire the fictional pipeline.\n\nDone when:\n- CI passes on main", projectId: delivery.id });
  assignIssue(context, ci.identifier, human.id);
  createIssue(context, { title: "Write fictional docs", projectId: delivery.id });
  createIssue(context, { title: "Retire fictional flag" });
  createIssue(context, { title: "Claimable fictional task" });
  addComment(context, { issue: ci.identifier, body: "Decision: use the fictional runner." });
  addAttachment(context, { issue: ci.identifier, kind: "link", title: "Fictional spec", url: "https://example.test/spec" });
  createTeam(context, { key: "OPS", name: "Fictional Ops" });
  createSavedView(context, { name: "Mine", filters: { team: "ENG" } });
  createTemplate(context, { name: "Bugfix", title: "Fix fictional bug", team: "ENG" });
  addProfile(context, { ...builtinProfileInput(), name: "Fictional Review", isDefault: false });

  const inspector = createNodeRepositoryInspector();
  const primary = addRepository(context, { name: "Primary", path: gitRepository(root, "primary"), ...commands }, inspector);
  addRepository(context, { name: "Secondary", path: gitRepository(root, "secondary"), ...commands }, inspector);
  const tertiaryPath = gitRepository(root, "tertiary");
  associateRepository(context, { repository: primary.id, project: delivery.id, position: 0, isDefault: true, overrideKind: "replace" });

  const runtime = { inspector, dataRoot: join(root, "run-data") };
  const preview = previewRun(context, { issue: ci.identifier }, runtime);
  const run = startRun(context, { issue: ci.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);

  const client = (context.db as unknown as { $client: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).$client;
  const insertRun = client.prepare(`INSERT INTO agent_runs (id, issue_id, profile_id, workflow, workflow_version, schema_version, resolved_configuration, phase, state, primary_repository_id, base_ref, base_commit, branch, worktree_path, parallel_group, event_counter, attempt_counter, started_at, last_event_at, last_progress_at, completed_at, outcome, error, archived_at, created_at, updated_at)
    VALUES (?, ?, NULL, 'fictional-flow', 1, 1, ?, 'implement', ?, ?, 'main', ?, ?, ?, NULL, 0, 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`);
  const terminal: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const id = randomUUID();
    const at = `2025-12-0${index + 1}T00:00:00.000Z`;
    insertRun.run(id, ci.id, JSON.stringify(run.resolvedConfiguration), "failed", primary.id, "0".repeat(40), `fictional/run-${index}`, `/fictional/worktrees/run-${index}`, at, at, at, at, "failed", JSON.stringify({ code: "fictional_failure" }), at, at);
    terminal.push(id);
  }
  // One terminal run reopened as blocked, for retry.
  const retry = createIssue(context, { title: "Retry fictional build" });
  client.prepare("UPDATE agent_runs SET issue_id = ?, state = 'blocked', completed_at = NULL, outcome = NULL WHERE id = ?").run(retry.id, terminal[2]);
  return { run: run.id, archivable: terminal[0]!, cleanable: terminal[1]!, retryable: terminal[2]!, tertiaryPath, commands };
}

function userTables(raw: RawDb): string[] {
  return (raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string; sql: string | null }>)
    .filter(({ name, sql }) => !name.startsWith("sqlite_") && !name.startsWith("__") && !name.startsWith("issues_fts") && !/VIRTUAL TABLE/i.test(sql ?? ""))
    .map(({ name }) => name);
}

/** Records every UPDATE (with the columns whose values changed) and every DELETE on user tables. */
function installAuditTriggers(raw: RawDb) {
  raw.exec("CREATE TABLE IF NOT EXISTS __contract_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, op TEXT NOT NULL, changed TEXT NOT NULL)");
  for (const table of userTables(raw)) {
    const columns = (raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((column) => column.name);
    const changed = columns.map((column) => `CASE WHEN OLD."${column}" IS NOT NEW."${column}" THEN '${column},' ELSE '' END`).join(" || ");
    raw.exec(`CREATE TRIGGER "__audit_update_${table}" AFTER UPDATE ON "${table}" BEGIN INSERT INTO __contract_audit (tbl, op, changed) VALUES ('${table}', 'UPDATE', ${changed}); END;`);
    raw.exec(`CREATE TRIGGER "__audit_delete_${table}" AFTER DELETE ON "${table}" BEGIN INSERT INTO __contract_audit (tbl, op, changed) VALUES ('${table}', 'DELETE', ''); END;`);
  }
}
