import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  AppError,
  AppErrorCode,
  applyMigrations,
  createActor,
  getActor,
  openDb,
  systemClock,
  type Actor,
  type Clock,
  type Db,
  type ServiceContext
} from "@issue-tracker/core";

export interface McpActorContext {
  handle: string;
  type?: "agent" | "human";
  name?: string;
}

export interface OpenMcpContextOptions {
  dbPath: string;
  actor?: McpActorContext;
  clock?: Clock;
  requireActor?: boolean;
}

export interface McpContext {
  context: ServiceContext;
  db: Db;
  close: () => void;
}

export function openMcpContext(options: OpenMcpContextOptions): McpContext {
  mkdirSync(dirname(options.dbPath), { recursive: true });

  const db = openDb(options.dbPath);
  applyMigrations(db);

  const context: ServiceContext = {
    db,
    actor: null,
    clock: options.clock ?? systemClock
  };

  if (options.actor) {
    context.actor = resolveMcpActor(context, options.actor);
  } else if (options.requireActor ?? true) {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      "MCP mutations require an agent actor handle."
    );
  }

  return {
    context,
    db,
    close: () => db.$client.close()
  };
}

export function resolveMcpActor(
  context: ServiceContext,
  actorContext: McpActorContext
): Actor {
  try {
    return getActor(context, actorContext.handle);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== AppErrorCode.ACTOR_NOT_FOUND) {
      throw error;
    }
  }

  if (actorContext.type === "human") {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      `Actor ${actorContext.handle} was not found.`,
      { actor: actorContext.handle }
    );
  }

  return createActor(context, {
    type: "agent",
    handle: actorContext.handle,
    name: actorContext.name ?? actorContext.handle
  });
}
