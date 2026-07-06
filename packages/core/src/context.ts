import type { BetterSQLiteTransaction } from "drizzle-orm/better-sqlite3/session";
import type { ExtractTablesWithRelations } from "drizzle-orm";

import type { Clock } from "./clock.js";
import type { Db } from "./db/client.js";
import type { Actor } from "./db/schema.js";
import * as schema from "./db/schema.js";

export type ServiceTransaction = BetterSQLiteTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type ServiceDb = Db | ServiceTransaction;

export interface ServiceContext {
  db: ServiceDb;
  actor: Actor | null;
  clock: Clock;
}

export function inTransaction<T>(
  context: ServiceContext,
  work: (context: ServiceContext & { db: ServiceTransaction }) => T
): T {
  return context.db.transaction((tx) => work({ ...context, db: tx }), {
    behavior: "immediate"
  });
}
