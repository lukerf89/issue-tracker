import { eq } from "drizzle-orm";

import type { ServiceContext } from "../context.js";
import { AppError, AppErrorCode } from "../errors.js";
import { actors, config } from "../db/schema.js";

export const ConfigKey = {
  DEFAULT_TEAM: "default_team",
  DEFAULT_ACTOR: "default_actor"
} as const;

export function getConfig(context: ServiceContext, key: string): string | null {
  const row = context.db.query.config.findFirst({
    where: eq(config.key, key)
  }).sync();

  return row?.value ?? null;
}

export function setConfig(context: ServiceContext, key: string, value: string): void {
  const now = context.clock.now().toISOString();

  context.db
    .insert(config)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: config.key,
      set: { value, updatedAt: now }
    })
    .run();
}

export function whoami(context: ServiceContext) {
  const actorId = getConfig(context, ConfigKey.DEFAULT_ACTOR);

  if (!actorId) {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      "Default actor is not configured.",
      { key: ConfigKey.DEFAULT_ACTOR }
    );
  }

  const actor = context.db.query.actors.findFirst({
    where: eq(actors.id, actorId)
  }).sync();

  if (!actor) {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      `Default actor ${actorId} was not found.`,
      { actorId }
    );
  }

  return actor;
}
