import { and, asc, desc, eq } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { cycles, teams, type Cycle } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { ConfigKey, getConfig } from "./config.js";
import { getTeamByKey } from "./team.js";

export type CycleRef = string | number;

export interface CreateCycleInput {
  team?: string;
  teamId?: string;
  number?: number;
  name?: string | null;
  startsAt?: string;
  endsAt?: string;
}

export interface ListCyclesOptions {
  team?: string;
  teamId?: string;
}

export function createCycle(context: ServiceContext, input: CreateCycleInput) {
  return inTransaction(context, (txContext) => {
    const team = resolveTeam(txContext, input.teamId ?? input.team);
    const number = input.number ?? nextCycleNumber(txContext, team.id);
    const existing = txContext.db.query.cycles.findFirst({
      where: and(eq(cycles.teamId, team.id), eq(cycles.number, number))
    }).sync();

    if (existing) {
      throw new AppError(
        AppErrorCode.CONSTRAINT_VIOLATION,
        `Cycle ${number} already exists for team ${team.key}.`,
        { teamId: team.id, team: team.key, number }
      );
    }

    const now = txContext.clock.now();
    const row = {
      id: uuid(),
      teamId: team.id,
      number,
      name: input.name ?? null,
      startsAt: normalizeTimestamp(input.startsAt, now),
      endsAt: normalizeTimestamp(input.endsAt, now)
    };

    txContext.db.insert(cycles).values(row).run();
    return getCycleById(txContext, row.id);
  });
}

export function listCycles(
  context: ServiceContext,
  options: ListCyclesOptions = {}
) {
  const teamRef = options.teamId ?? options.team;
  const team = teamRef ? resolveTeam(context, teamRef) : null;

  return context.db.query.cycles.findMany({
    where: team ? eq(cycles.teamId, team.id) : undefined,
    orderBy: [asc(cycles.teamId), asc(cycles.number), asc(cycles.id)]
  }).sync();
}

export function getCycle(context: ServiceContext, ref: CycleRef, teamId?: string): Cycle {
  const cycle = findCycle(context, ref, teamId);

  if (!cycle) {
    throw new AppError(
      AppErrorCode.CYCLE_NOT_FOUND,
      `Cycle ${String(ref)} was not found.`,
      { cycle: ref, teamId: teamId ?? null }
    );
  }

  return cycle;
}

export function resolveOptionalCycleId(
  context: ServiceContext,
  ref: CycleRef | null | undefined,
  teamId: string
): string | null {
  return ref == null ? null : getCycle(context, ref, teamId).id;
}

export function cycleIdsForIssueFilter(
  context: ServiceContext,
  ref: CycleRef,
  teamRef?: string
): string[] {
  const team = teamRef ? resolveTeam(context, teamRef) : null;
  const cycleNumber = cycleNumberRef(ref);

  if (cycleNumber !== null) {
    const found = context.db.query.cycles.findMany({
      where: team
        ? and(eq(cycles.teamId, team.id), eq(cycles.number, cycleNumber))
        : eq(cycles.number, cycleNumber),
      orderBy: [asc(cycles.teamId), asc(cycles.number), asc(cycles.id)]
    }).sync();

    return found.map((cycle) => cycle.id);
  }

  const cycle = context.db.query.cycles.findFirst({
    where: eq(cycles.id, String(ref))
  }).sync();

  if (!cycle || (team && cycle.teamId !== team.id)) {
    return [];
  }

  return [cycle.id];
}

function findCycle(context: ServiceContext, ref: CycleRef, teamId?: string): Cycle | null {
  const cycleNumber = cycleNumberRef(ref);

  if (cycleNumber !== null) {
    if (!teamId) {
      throw new AppError(
        AppErrorCode.CONSTRAINT_VIOLATION,
        `Cycle ${cycleNumber} requires a team context.`,
        { cycle: cycleNumber }
      );
    }

    return context.db.query.cycles.findFirst({
      where: and(eq(cycles.teamId, teamId), eq(cycles.number, cycleNumber))
    }).sync() ?? null;
  }

  const cycle = context.db.query.cycles.findFirst({
    where: eq(cycles.id, String(ref))
  }).sync();

  if (!cycle || (teamId && cycle.teamId !== teamId)) {
    return null;
  }

  return cycle;
}

function nextCycleNumber(context: ServiceContext, teamId: string): number {
  const latest = context.db.query.cycles.findFirst({
    where: eq(cycles.teamId, teamId),
    orderBy: [desc(cycles.number)]
  }).sync();

  return (latest?.number ?? 0) + 1;
}

function resolveTeam(context: ServiceContext, idOrKey?: string) {
  const teamRef = idOrKey ?? getConfig(context, ConfigKey.DEFAULT_TEAM);

  if (!teamRef) {
    throw new AppError(
      AppErrorCode.TEAM_NOT_FOUND,
      "Default team is not configured.",
      { key: ConfigKey.DEFAULT_TEAM }
    );
  }

  const byId = context.db.query.teams.findFirst({
    where: eq(teams.id, teamRef)
  }).sync();

  return byId ?? getTeamByKey(context, teamRef);
}

function getCycleById(context: ServiceContext, id: string): Cycle {
  const cycle = context.db.query.cycles.findFirst({
    where: eq(cycles.id, id)
  }).sync();

  if (!cycle) {
    throw new AppError(AppErrorCode.CYCLE_NOT_FOUND, `Cycle ${id} was not found.`, {
      cycle: id
    });
  }

  return cycle;
}

function normalizeTimestamp(value: string | undefined, fallback: Date): string {
  const date = value === undefined ? fallback : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new AppError(
      AppErrorCode.VALIDATION_FAILED,
      `Cycle timestamp ${value} is invalid.`,
      { timestamp: value }
    );
  }

  return date.toISOString();
}

function cycleNumberRef(ref: CycleRef): number | null {
  if (typeof ref === "number") {
    return ref;
  }

  return /^[1-9]\d*$/.test(ref) ? Number.parseInt(ref, 10) : null;
}
