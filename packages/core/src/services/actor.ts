import { asc, eq, isNull } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { actors } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";

export interface CreateActorInput {
  type: "human" | "agent";
  name: string;
  handle: string;
}

export interface ListActorsOptions {
  includeArchived?: boolean;
}

export function createActor(context: ServiceContext, input: CreateActorInput) {
  return inTransaction(context, (txContext) => {
    const existing = txContext.db.query.actors.findFirst({
      where: eq(actors.handle, input.handle)
    }).sync();

    if (existing) {
      throw new AppError(
        AppErrorCode.ACTOR_HANDLE_TAKEN,
        `Actor handle ${input.handle} is already taken.`,
        { handle: input.handle }
      );
    }

    const row = {
      id: uuid(),
      type: input.type,
      name: input.name,
      handle: input.handle,
      archivedAt: null
    };

    txContext.db.insert(actors).values(row).run();
    return row;
  });
}

export function listActors(context: ServiceContext, options: ListActorsOptions = {}) {
  return context.db.query.actors.findMany({
    where: options.includeArchived ? undefined : isNull(actors.archivedAt),
    orderBy: [asc(actors.handle)]
  }).sync();
}

export function getActor(context: ServiceContext, idOrHandle: string) {
  const byId = context.db.query.actors.findFirst({
    where: eq(actors.id, idOrHandle)
  }).sync();

  if (byId) {
    return byId;
  }

  const byHandle = context.db.query.actors.findFirst({
    where: eq(actors.handle, idOrHandle)
  }).sync();

  if (!byHandle) {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      `Actor ${idOrHandle} was not found.`,
      { actor: idOrHandle }
    );
  }

  return byHandle;
}
