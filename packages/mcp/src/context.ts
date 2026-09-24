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
  /**
   * Whether an unknown agent handle is created on first use (default true). Read-only tools pass
   * false: the handle is looked up, and a miss leaves `context.actor` null instead of writing.
   */
  provisionActor?: boolean;
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
    context.actor = options.provisionActor === false
      ? findMcpActor(context, options.actor)
      : resolveMcpActor(context, options.actor);
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

/**
 * Looks up the caller's actor without creating it. An unknown agent handle yields null (it would be
 * provisioned on its first write); an unknown human handle is never provisioned, so it fails.
 */
export function findMcpActor(context: ServiceContext, actorContext: McpActorContext): Actor | null {
  try {
    return getActor(context, actorContext.handle);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== AppErrorCode.ACTOR_NOT_FOUND) throw error;
  }

  if (actorContext.type === "human") {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      `Actor ${actorContext.handle} was not found.`,
      { actor: actorContext.handle }
    );
  }

  return null;
}

export function resolveMcpActor(
  context: ServiceContext,
  actorContext: McpActorContext
): Actor {
  return findMcpActor(context, actorContext) ?? createActor(context, {
    type: "agent",
    handle: actorContext.handle,
    name: actorContext.name ?? actorContext.handle
  });
}
