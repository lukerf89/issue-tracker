import { createHash } from "node:crypto";
import { describeTrackerInputSchema } from "../schemas/metadata.js";
import type { z } from "zod";
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

export function describeTracker(context: ServiceContext, input: z.input<typeof describeTrackerInputSchema> = {}) {
  const options = describeTrackerInputSchema.parse(input);
  const team = options.team ? resolveTeam(context, options.team) : null;
  const sections = new Set(options.sections ?? ["teams", "priorities", "labelGroups", "projects", "actor"]);
  const payload = {
    ...(sections.has("teams") ? { teams: (team ? [team] : listTeams(context)).map((entry) => ({
      id: entry.id, key: entry.key, name: entry.name,
      states: listStates(context, entry.id).map(serializeWorkflowState)
    })) } : {}),
    ...(sections.has("priorities") ? { priorities: priorityLabels } : {}),
    ...(sections.has("labelGroups") ? { labelGroups: groupLabels(listLabels(context)) } : {}),
    ...(sections.has("projects") ? { projects: listProjects(context).map((entry) => options.compact
      ? { id: entry.id, name: entry.name, status: entry.status }
      : serializeProject(entry)) } : {}),
    ...(sections.has("actor") ? { actor: serializeActor(context.actor ?? whoami(context)) } : {})
  };
  return { ...payload, metadataRevision: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
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
