import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyMigrations,
  openDb,
  systemClock,
  whoami,
  type Db,
  type ServiceContext
} from "@issue-tracker/core";

export interface CliGlobalOptions {
  db?: string;
  team?: string;
}

export interface CliContext {
  context: ServiceContext;
  db: Db;
  dbPath: string;
  defaultTeam?: string;
  close: () => void;
}

export function resolveDbPath(
  options: Pick<CliGlobalOptions, "db">,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (options.db) return options.db;
  if (env.ISSUE_TRACKER_DB) return env.ISSUE_TRACKER_DB;

  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "issue-tracker", "tracker.db");
}

export function openCliContext(
  options: CliGlobalOptions,
  contextOptions: { requireActor?: boolean } = {}
): CliContext {
  const dbPath = resolveDbPath(options);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDb(dbPath);
  applyMigrations(db);

  const context: ServiceContext = {
    db,
    actor: null,
    clock: systemClock
  };

  if (contextOptions.requireActor ?? true) {
    context.actor = whoami(context);
  }

  return {
    context,
    db,
    dbPath,
    defaultTeam: options.team,
    close: () => db.$client.close()
  };
}
