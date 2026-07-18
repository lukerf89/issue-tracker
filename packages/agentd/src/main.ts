import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyMigrations, createNodeEngineCatalogRuntime, loadEngineCatalog, openDb, resolveEngineCatalogPath, systemClock, whoami, type ServiceContext } from "@issue-tracker/core";

import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";
import { Supervisor } from "./supervisor.js";

export async function runAgentd(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const dataHome = process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share");
  const dataRoot = options.dataRoot ?? resolve(dataHome, "issue-tracker");
  const dbPath = options.db ?? process.env.ISSUE_TRACKER_DB ?? resolve(dataRoot, "tracker.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath); applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: systemClock };
  context.actor = whoami(context);
  const catalog = loadEngineCatalog(options.config ?? resolveEngineCatalogPath(), createNodeEngineCatalogRuntime());
  const supervisor = new Supervisor({ id: options.id ?? `agentd-${process.pid}`, context, dataRoot, dbPath, engines: catalog.engines, adapters: { "claude-code": new ClaudeCodeAdapter(), codex: new CodexAdapter() } });
  const controller = new AbortController();
  const stop = () => { controller.abort(); supervisor.stop(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await supervisor.start(controller.signal); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); db.$client.close(); }
}

function parseArgs(argv: string[]) {
  const options: { db?: string; dataRoot?: string; config?: string; id?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!["--db", "--data-root", "--config", "--id"].includes(flag ?? "") || !value) throw new Error(`Usage: tracker-agentd [--db PATH] [--data-root PATH] [--config PATH] [--id ID]`);
    if (flag === "--db") options.db = value;
    if (flag === "--data-root") options.dataRoot = value;
    if (flag === "--config") options.config = value;
    if (flag === "--id") options.id = value;
    index += 1;
  }
  return options;
}

export function isAgentdEntrypoint(argv = process.argv) {
  if (!argv[1]) return false;
  const current = realpathOrResolve(fileURLToPath(import.meta.url));
  return current.endsWith("/main.js") && realpathOrResolve(argv[1]).endsWith("/index.js");
}

function realpathOrResolve(path: string) { try { return realpathSync(path); } catch { return resolve(path); } }
