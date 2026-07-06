import { asc, eq, isNull } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { projects } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  status?: "backlog" | "planned" | "started" | "paused" | "completed" | "canceled";
  leadId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
}

export type UpdateProjectInput = Partial<CreateProjectInput>;

export interface ArchiveProjectInput {
  project: string;
}

export function createProject(context: ServiceContext, input: CreateProjectInput) {
  return inTransaction(context, (txContext) => {
    const row = {
      id: uuid(),
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? "backlog",
      leadId: input.leadId ?? null,
      startDate: input.startDate ?? null,
      targetDate: input.targetDate ?? null,
      archivedAt: null
    };

    txContext.db.insert(projects).values(row).run();
    return row;
  });
}

export function listProjects(
  context: ServiceContext,
  options: { includeArchived?: boolean } = {}
) {
  return context.db.query.projects.findMany({
    where: options.includeArchived ? undefined : isNull(projects.archivedAt),
    orderBy: [asc(projects.name), asc(projects.id)]
  }).sync();
}

export function getProject(context: ServiceContext, idOrName: string) {
  const project = findProject(context, idOrName);

  if (!project) {
    throw new AppError(
      AppErrorCode.PROJECT_NOT_FOUND,
      `Project ${idOrName} was not found.`,
      { project: idOrName }
    );
  }

  return project;
}

export function archiveProject(context: ServiceContext, idOrName: string) {
  return inTransaction(context, (txContext) => {
    const project = getProject(txContext, idOrName);

    if (project.archivedAt !== null) {
      throw new AppError(
        AppErrorCode.CONSTRAINT_VIOLATION,
        `Project ${project.name} is already archived.`,
        { project: idOrName, id: project.id }
      );
    }

    txContext.db
      .update(projects)
      .set({ archivedAt: txContext.clock.now().toISOString() })
      .where(eq(projects.id, project.id))
      .run();

    return getProject(txContext, project.id);
  });
}

export function unarchiveProject(context: ServiceContext, idOrName: string) {
  return inTransaction(context, (txContext) => {
    const project = getProject(txContext, idOrName);

    if (project.archivedAt === null) {
      throw new AppError(
        AppErrorCode.CONSTRAINT_VIOLATION,
        `Project ${project.name} is not archived.`,
        { project: idOrName, id: project.id }
      );
    }

    txContext.db
      .update(projects)
      .set({ archivedAt: null })
      .where(eq(projects.id, project.id))
      .run();

    return getProject(txContext, project.id);
  });
}

export function updateProject(context: ServiceContext, idOrName: string, input: UpdateProjectInput) {
  return inTransaction(context, (txContext) => {
    const project = getProject(txContext, idOrName);
    const changes: Partial<typeof projects.$inferInsert> = {};

    if (has(input, "name")) changes.name = input.name;
    if (has(input, "description")) changes.description = input.description ?? null;
    if (has(input, "status")) changes.status = input.status;
    if (has(input, "leadId")) changes.leadId = input.leadId ?? null;
    if (has(input, "startDate")) changes.startDate = input.startDate ?? null;
    if (has(input, "targetDate")) changes.targetDate = input.targetDate ?? null;

    txContext.db.update(projects).set(changes).where(eq(projects.id, project.id)).run();
    return getProject(txContext, project.id);
  });
}

function findProject(context: ServiceContext, idOrName: string) {
  return (
    context.db.query.projects.findFirst({
      where: eq(projects.id, idOrName)
    }).sync() ??
    context.db.query.projects.findFirst({
      where: eq(projects.name, idOrName)
    }).sync()
  );
}

function has<T extends object>(object: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
