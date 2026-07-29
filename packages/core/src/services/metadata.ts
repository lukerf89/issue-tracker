import type { Label } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { serializeActor, serializeLabel, serializeProject, serializeWorkflowState } from "../serialize.js";
import { whoami } from "./config.js";
import { listLabels } from "./label.js";
import { listProjects } from "./project.js";
import { listStates } from "./state.js";
import { getTeam, getTeamByKey, listTeams } from "./team.js";
import type { ServiceContext } from "../context.js";

export const priorityLabels = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low"
} as const;

export function listStatesForTeam(context: ServiceContext, idOrKey: string) {
  return listStates(context, resolveTeam(context, idOrKey).id);
}

export function describeTracker(context: ServiceContext) {
  const teams = listTeams(context).map((team) => ({
    id: team.id,
    key: team.key,
    name: team.name,
    states: listStates(context, team.id).map(serializeWorkflowState)
  }));

  return {
    teams,
    priorities: priorityLabels,
    labelGroups: groupLabels(listLabels(context)),
    projects: listProjects(context).map(serializeProject),
    actor: serializeActor(context.actor ?? whoami(context))
  };
}

function resolveTeam(context: ServiceContext, idOrKey: string) {
  try {
    return getTeam(context, idOrKey);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== AppErrorCode.TEAM_NOT_FOUND) {
      throw error;
    }

    return getTeamByKey(context, idOrKey);
  }
}

function groupLabels(labels: Label[]) {
  const groups = new Map<string | null, Label[]>();

  for (const label of labels) {
    const group = label.group ?? null;
    groups.set(group, [...(groups.get(group) ?? []), label]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => {
      const leftKey = left ?? "";
      const rightKey = right ?? "";
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map(([group, entries]) => ({ group, labels: entries.map(serializeLabel) }));
}
