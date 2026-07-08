import { eq } from "drizzle-orm";

import { inTransaction, type ServiceContext, type ServiceTransaction } from "../context.js";
import { AppError, AppErrorCode } from "../errors.js";
import { actors, config, teams } from "../db/schema.js";

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
  inTransaction(context, (txContext) => setConfigInTransaction(txContext, key, value));
}

export function setConfigInTransaction(
  context: ServiceContext & { db: ServiceTransaction },
  key: string,
  value: string
): void {
  const now = context.clock.now().toISOString();
  const normalizedValue = normalizeConfigValue(context, key, value);

  context.db
    .insert(config)
    .values({ key, value: normalizedValue, updatedAt: now })
    .onConflictDoUpdate({
      target: config.key,
      set: { value: normalizedValue, updatedAt: now }
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

function normalizeConfigValue(
  context: ServiceContext,
  key: string,
  value: string
): string {
  if (key === ConfigKey.DEFAULT_ACTOR) {
    return resolveActorId(context, value);
  }

  if (key === ConfigKey.DEFAULT_TEAM) {
    return resolveTeamId(context, value);
  }

  return value;
}

function resolveActorId(context: ServiceContext, idOrHandle: string): string {
  const actor =
    context.db.query.actors.findFirst({ where: eq(actors.id, idOrHandle) }).sync() ??
    context.db.query.actors.findFirst({ where: eq(actors.handle, idOrHandle) }).sync();

  if (!actor) {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      `Actor ${idOrHandle} was not found.`,
      { actor: idOrHandle }
    );
  }

  return actor.id;
}

function resolveTeamId(context: ServiceContext, idOrKey: string): string {
  const normalizedKey = idOrKey.trim().toUpperCase();
  const team =
    context.db.query.teams.findFirst({ where: eq(teams.id, idOrKey) }).sync() ??
    context.db.query.teams.findFirst({ where: eq(teams.key, normalizedKey) }).sync();

  if (!team) {
    throw new AppError(
      AppErrorCode.TEAM_NOT_FOUND,
      `Team ${normalizedKey} was not found.`,
      { team: idOrKey, key: normalizedKey }
    );
  }

  return team.id;
}
