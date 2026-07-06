import { asc, eq, isNull } from "drizzle-orm";

import type { ServiceContext } from "../context.js";
import { teams } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { seedDefaultWorkflowStates } from "./state.js";

export interface CreateTeamInput {
  key: string;
  name: string;
}

export function createTeam(context: ServiceContext, input: CreateTeamInput) {
  const key = normalizeTeamKey(input.key);
  const existing = context.db.query.teams.findFirst({
    where: eq(teams.key, key)
  }).sync();

  if (existing) {
    throw new AppError(
      AppErrorCode.TEAM_KEY_TAKEN,
      `Team key ${key} is already taken.`,
      { key }
    );
  }

  const row = {
    id: uuid(),
    key,
    name: input.name,
    issueCounter: 0,
    archivedAt: null
  };

  context.db.insert(teams).values(row).run();
  seedDefaultWorkflowStates(context, row.id);
  return row;
}

export function listTeams(context: ServiceContext, options: { includeArchived?: boolean } = {}) {
  return context.db.query.teams.findMany({
    where: options.includeArchived ? undefined : isNull(teams.archivedAt),
    orderBy: [asc(teams.key)]
  }).sync();
}

export function getTeamByKey(context: ServiceContext, key: string) {
  const normalizedKey = normalizeTeamKey(key);
  const team = context.db.query.teams.findFirst({
    where: eq(teams.key, normalizedKey)
  }).sync();

  if (!team) {
    throw new AppError(
      AppErrorCode.TEAM_NOT_FOUND,
      `Team ${normalizedKey} was not found.`,
      { key: normalizedKey }
    );
  }

  return team;
}

export function getTeam(context: ServiceContext, id: string) {
  const team = context.db.query.teams.findFirst({
    where: eq(teams.id, id)
  }).sync();

  if (!team) {
    throw new AppError(AppErrorCode.TEAM_NOT_FOUND, `Team ${id} was not found.`, {
      id
    });
  }

  return team;
}

function normalizeTeamKey(key: string): string {
  return key.trim().toUpperCase();
}
