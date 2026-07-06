"use server";

import {
  addAttachment,
  addComment,
  archiveIssue,
  archiveLabel,
  archiveProject,
  archiveTeam,
  assignIssue,
  attachLabel,
  createActor,
  createCycle,
  createIssue,
  createLabel,
  createProject,
  createTeam,
  detachLabel,
  moveIssue,
  moveIssueInputSchema,
  serializeActor,
  serializeAttachment,
  serializeComment,
  serializeCycle,
  serializeIssue,
  serializeLabel,
  serializeProject,
  serializeTeam,
  unarchiveIssue,
  unarchiveLabel,
  unarchiveProject,
  unarchiveTeam,
  updateIssue,
  updateProject,
  type AddAttachmentInput,
  type AddCommentInput,
  type AssignIssueInput,
  type CreateActorInput,
  type CreateCycleInput,
  type CreateIssueInput,
  type CreateLabelInput,
  type CreateProjectInput,
  type CreateTeamInput,
  type UpdateIssueInput,
  type UpdateProjectInput
} from "@issue-tracker/core";

import { withTrackerContext } from "./context";

export async function createIssueAction(input: CreateIssueInput) {
  return withTrackerContext((context) => serializeIssue(createIssue(context, input)));
}

export async function updateIssueAction(identifier: string, input: UpdateIssueInput) {
  return withTrackerContext((context) => serializeIssue(updateIssue(context, identifier, input)));
}

export async function moveIssueAction(identifier: string, state: string) {
  return withTrackerContext((context) => serializeIssue(moveIssue(context, identifier, state)));
}

export async function moveBoardIssueAction(formData: FormData) {
  const input = moveIssueInputSchema.parse({
    identifier: formString(formData.get("identifier")),
    state: formString(formData.get("state"))
  });

  await moveIssueAction(input.identifier, input.state);
}

export async function assignIssueAction(input: AssignIssueInput) {
  return withTrackerContext((context) =>
    serializeIssue(assignIssue(context, input.identifier, input.actor))
  );
}

export async function archiveIssueAction(identifier: string) {
  return withTrackerContext((context) => serializeIssue(archiveIssue(context, identifier)));
}

export async function unarchiveIssueAction(identifier: string) {
  return withTrackerContext((context) => serializeIssue(unarchiveIssue(context, identifier)));
}

export async function createProjectAction(input: CreateProjectInput) {
  return withTrackerContext((context) => serializeProject(createProject(context, input)));
}

export async function updateProjectAction(project: string, input: UpdateProjectInput) {
  return withTrackerContext((context) => serializeProject(updateProject(context, project, input)));
}

export async function archiveProjectAction(project: string) {
  return withTrackerContext((context) => serializeProject(archiveProject(context, project)));
}

export async function unarchiveProjectAction(project: string) {
  return withTrackerContext((context) => serializeProject(unarchiveProject(context, project)));
}

export async function createTeamAction(input: CreateTeamInput) {
  return withTrackerContext((context) => serializeTeam(createTeam(context, input)));
}

export async function archiveTeamAction(team: string) {
  return withTrackerContext((context) => serializeTeam(archiveTeam(context, team)));
}

export async function unarchiveTeamAction(team: string) {
  return withTrackerContext((context) => serializeTeam(unarchiveTeam(context, team)));
}

export async function createLabelAction(input: CreateLabelInput) {
  return withTrackerContext((context) => serializeLabel(createLabel(context, input)));
}

export async function archiveLabelAction(label: string) {
  return withTrackerContext((context) => serializeLabel(archiveLabel(context, label)));
}

export async function unarchiveLabelAction(label: string) {
  return withTrackerContext((context) => serializeLabel(unarchiveLabel(context, label)));
}

export async function attachLabelAction(issueId: string, labelId: string) {
  return withTrackerContext((context) => serializeLabel(attachLabel(context, issueId, labelId)));
}

export async function detachLabelAction(issueId: string, labelId: string) {
  return withTrackerContext((context) => serializeLabel(detachLabel(context, issueId, labelId)));
}

export async function createCycleAction(input: CreateCycleInput) {
  return withTrackerContext((context) => serializeCycle(createCycle(context, input)));
}

export async function createActorAction(input: CreateActorInput) {
  return withTrackerContext((context) => serializeActor(createActor(context, input)));
}

export async function addCommentAction(input: AddCommentInput) {
  return withTrackerContext((context) => serializeComment(addComment(context, input)));
}

export async function addAttachmentAction(input: AddAttachmentInput) {
  return withTrackerContext((context) => serializeAttachment(addAttachment(context, input)));
}

function formString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}
