import { and, asc, eq } from "drizzle-orm";

import type { ServiceContext } from "../context.js";
import { workflowStates } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";

export const defaultWorkflowStates = [
  { name: "Backlog", type: "backlog", color: "#9CA3AF", position: 0 },
  { name: "Todo", type: "unstarted", color: "#6B7280", position: 1 },
  { name: "In Progress", type: "started", color: "#2563EB", position: 2 },
  { name: "Done", type: "completed", color: "#16A34A", position: 3 },
  { name: "Canceled", type: "canceled", color: "#DC2626", position: 4 }
] as const;

export function seedDefaultWorkflowStates(context: ServiceContext, teamId: string) {
  const rows = defaultWorkflowStates.map((state) => ({
    id: uuid(),
    teamId,
    name: state.name,
    type: state.type,
    color: state.color,
    position: state.position
  }));

  context.db.insert(workflowStates).values(rows).run();
  return rows;
}

export function listStates(context: ServiceContext, teamId: string) {
  return context.db.query.workflowStates.findMany({
    where: eq(workflowStates.teamId, teamId),
    orderBy: [asc(workflowStates.position), asc(workflowStates.name)]
  }).sync();
}

export function getState(context: ServiceContext, idOrName: string, teamId?: string) {
  const byId = context.db.query.workflowStates.findFirst({
    where: eq(workflowStates.id, idOrName)
  }).sync();

  if (byId && (!teamId || byId.teamId === teamId)) {
    return byId;
  }

  const byName = context.db.query.workflowStates.findFirst({
    where: teamId
      ? and(eq(workflowStates.teamId, teamId), eq(workflowStates.name, idOrName))
      : eq(workflowStates.name, idOrName)
  }).sync();

  if (!byName) {
    throw new AppError(
      AppErrorCode.WORKFLOW_STATE_NOT_FOUND,
      `Workflow state ${idOrName} was not found.`,
      { state: idOrName, teamId: teamId ?? null }
    );
  }

  return byName;
}

export function resolveDefaultUnstartedState(context: ServiceContext, teamId: string) {
  const state = context.db.query.workflowStates.findFirst({
    where: and(eq(workflowStates.teamId, teamId), eq(workflowStates.type, "unstarted")),
    orderBy: [asc(workflowStates.position), asc(workflowStates.name)]
  }).sync();

  if (!state) {
    throw new AppError(
      AppErrorCode.WORKFLOW_STATE_NOT_FOUND,
      "Default unstarted workflow state was not found.",
      { teamId }
    );
  }

  return state;
}
