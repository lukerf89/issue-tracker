import { asc, eq, isNull } from "drizzle-orm";

import { inTransaction, type ServiceContext, type ServiceTransaction } from "../context.js";
import { teams } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { seedDefaultWorkflowStatesInTransaction } from "./state.js";

export interface CreateTeamInput {
  key: string;
  name: string;
}

export interface ArchiveTeamInput {
  team: string;
}

export function createTeam(context: ServiceContext, input: CreateTeamInput) {
  return inTransaction(context, (txContext) =>
    createTeamInTransaction(txContext, input)
  );
}

export function createTeamInTransaction(
  context: ServiceContext & { db: ServiceTransaction },
  input: CreateTeamInput
) {
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
  seedDefaultWorkflowStatesInTransaction(context, row.id);
  return row;
}

export function listTeams(context: ServiceContext, options: { includeArchived?: boolean } = {}) {
  return context.db.query.teams.findMany({
    where: options.includeArchived ? undefined : isNull(teams.archivedAt),
    orderBy: [asc(teams.key)]
  }).sync();
}

export function archiveTeam(context: ServiceContext, idOrKey: string) {
  return inTransaction(context, (txContext) => {
    const team = getTeamForArchive(txContext, idOrKey);

    if (team.archivedAt !== null) {
      throw new AppError(
        AppErrorCode.CONSTRAINT_VIOLATION,
        `Team ${team.key} is already archived.`,
        { team: idOrKey, id: team.id, key: team.key }
      );
    }

    txContext.db
      .update(teams)
      .set({ archivedAt: txContext.clock.now().toISOString() })
      .where(eq(teams.id, team.id))
      .run();

    return getTeam(txContext, team.id);
  });
}

export function unarchiveTeam(context: ServiceContext, idOrKey: string) {
  return inTransaction(context, (txContext) => {
    const team = getTeamForArchive(txContext, idOrKey);

    if (team.archivedAt === null) {
      throw new AppError(
        AppErrorCode.CONSTRAINT_VIOLATION,
        `Team ${team.key} is not archived.`,
        { team: idOrKey, id: team.id, key: team.key }
      );
    }

    txContext.db
      .update(teams)
      .set({ archivedAt: null })
      .where(eq(teams.id, team.id))
      .run();

    return getTeam(txContext, team.id);
  });
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

function getTeamForArchive(context: ServiceContext, idOrKey: string) {
  const team = findTeamByIdOrKey(context, idOrKey);

  if (!team) {
    const normalizedKey = normalizeTeamKey(idOrKey);
    throw new AppError(
      AppErrorCode.TEAM_NOT_FOUND,
      `Team ${normalizedKey} was not found.`,
      { team: idOrKey, key: normalizedKey }
    );
  }

  return team;
}

function findTeamByIdOrKey(context: ServiceContext, idOrKey: string) {
  return (
    context.db.query.teams.findFirst({
      where: eq(teams.id, idOrKey)
    }).sync() ??
    context.db.query.teams.findFirst({
      where: eq(teams.key, normalizeTeamKey(idOrKey))
    }).sync() ??
    null
  );
}

function normalizeTeamKey(key: string): string {
  return key.trim().toUpperCase();
}
