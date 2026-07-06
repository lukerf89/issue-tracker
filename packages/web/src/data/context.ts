import "server-only";

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

export interface TrackerContext {
  context: ServiceContext;
  db: Db;
  dbPath: string;
  close: () => void;
}

export function resolveTrackerDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ISSUE_TRACKER_DB) return env.ISSUE_TRACKER_DB;

  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "issue-tracker", "tracker.db");
}

export function openTrackerContext(env: NodeJS.ProcessEnv = process.env): TrackerContext {
  const dbPath = resolveTrackerDbPath(env);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openDb(dbPath);
  applyMigrations(db);

  const context: ServiceContext = {
    db,
    actor: null,
    clock: systemClock
  };

  context.actor = whoami(context);

  return {
    context,
    db,
    dbPath,
    close: () => db.$client.close()
  };
}

export function withTrackerContext<T>(work: (context: ServiceContext) => T): T {
  const tracker = openTrackerContext();

  try {
    return work(tracker.context);
  } finally {
    tracker.close();
  }
}
