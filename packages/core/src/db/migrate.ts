import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { Db } from "./client.js";

export interface MigrationOptions {
  migrationsFolder?: string;
}

export function applyMigrations(db: Db, options: MigrationOptions = {}): void {
  migrate(db, {
    migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder()
  });
}

function defaultMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../migrations"), resolve(here, "../../src/migrations")];
  const existing = candidates.find((candidate) => existsSync(candidate));

  if (existing) {
    return existing;
  }

  return candidates[0];
}
