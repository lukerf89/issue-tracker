import "server-only";

import {
  getIssue,
  getLabel,
  getProject,
  getState,
  getTeam,
  getTeamByKey,
  listActors,
  listAttachments,
  listComments,
  listCycles,
  listIssueLabels,
  listIssues,
  listLabels,
  listProjects,
  listStates,
  listTeams,
  searchIssues,
  serializeActor,
  serializeAttachment,
  serializeComment,
  serializeCycle,
  serializeIssue,
  serializeLabel,
  serializeProject,
  serializeTeam,
  serializeWorkflowState,
  type ListActorsOptions,
  type ListAttachmentsInput,
  type ListCommentsInput,
  type ListCyclesOptions,
  type ListIssueFilters,
  type ListLabelsOptions,
  type SearchIssuesInput
} from "@issue-tracker/core";

import { withTrackerContext } from "./context";

export async function listIssuesData(filters: ListIssueFilters = {}) {
  return withTrackerContext((context) => listIssues(context, filters).map(serializeIssue));
}

export async function getIssueData(identifier: string) {
  return withTrackerContext((context) => serializeIssue(getIssue(context, identifier)));
}

export async function searchIssuesData(input: SearchIssuesInput) {
  return withTrackerContext((context) => searchIssues(context, input).map(serializeIssue));
}

export async function listProjectsData(options: { includeArchived?: boolean } = {}) {
  return withTrackerContext((context) => listProjects(context, options).map(serializeProject));
}

export async function getProjectData(idOrName: string) {
  return withTrackerContext((context) => serializeProject(getProject(context, idOrName)));
}

export async function listTeamsData(options: { includeArchived?: boolean } = {}) {
  return withTrackerContext((context) => listTeams(context, options).map(serializeTeam));
}

export async function getTeamData(id: string) {
  return withTrackerContext((context) => serializeTeam(getTeam(context, id)));
}

export async function getTeamByKeyData(key: string) {
  return withTrackerContext((context) => serializeTeam(getTeamByKey(context, key)));
}

export async function listStatesData(teamId: string) {
  return withTrackerContext((context) => listStates(context, teamId).map(serializeWorkflowState));
}

export async function getStateData(idOrName: string, teamId?: string) {
  return withTrackerContext((context) =>
    serializeWorkflowState(getState(context, idOrName, teamId))
  );
}

export async function listLabelsData(options: ListLabelsOptions = {}) {
  return withTrackerContext((context) => listLabels(context, options).map(serializeLabel));
}

export async function getLabelData(idOrName: string) {
  return withTrackerContext((context) => serializeLabel(getLabel(context, idOrName)));
}

export async function listIssueLabelsData(issueId: string) {
  return withTrackerContext((context) => listIssueLabels(context, issueId).map(serializeLabel));
}

export async function listCyclesData(options: ListCyclesOptions = {}) {
  return withTrackerContext((context) => listCycles(context, options).map(serializeCycle));
}

export async function listActorsData(options: ListActorsOptions = {}) {
  return withTrackerContext((context) => listActors(context, options).map(serializeActor));
}

export async function listCommentsData(input: ListCommentsInput) {
  return withTrackerContext((context) => listComments(context, input).map(serializeComment));
}

export async function listAttachmentsData(input: ListAttachmentsInput) {
  return withTrackerContext((context) => listAttachments(context, input).map(serializeAttachment));
}

export type IssueListPageFilters = ListIssueFilters;

export async function getIssueListPageData(filters: IssueListPageFilters = {}) {
  return withTrackerContext((context) => {
    const teams = listTeams(context).map(serializeTeam);
    const states = teams.flatMap((team) =>
      listStates(context, team.id).map(serializeWorkflowState)
    );

    return {
      issues: listIssues(context, filters).map(serializeIssue),
      projects: listProjects(context).map(serializeProject),
      teams,
      states,
      labels: listLabels(context).map(serializeLabel),
      actors: listActors(context, { includeArchived: true }).map(serializeActor),
      cycles: listCycles(context).map(serializeCycle)
    };
  });
}

export type IssueListPageData = Awaited<ReturnType<typeof getIssueListPageData>>;

export async function getBoardPageData() {
  return withTrackerContext((context) => {
    const teams = listTeams(context).map(serializeTeam);
    const states = teams.flatMap((team) =>
      listStates(context, team.id).map(serializeWorkflowState)
    );

    return {
      issues: listIssues(context).map(serializeIssue),
      states,
      teams
    };
  });
}
