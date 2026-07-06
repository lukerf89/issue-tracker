"use server";

import {
  addAttachment,
  addComment,
  addCommentInputSchema,
  archiveIssue,
  archiveLabel,
  archiveProject,
  archiveTeam,
  assignIssue,
  assignIssueInputSchema,
  attachLabel,
  createActor,
  createCycle,
  createIssue,
  createIssueInputSchema,
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
  updateIssueInputSchema,
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

export async function createIssueFormAction(formData: FormData) {
  const labels = formStrings(formData.getAll("labels"));
  const input = createIssueInputSchema.parse(
    omitUndefined({
      title: requiredFormString(formData, "title"),
      description: nullableFormString(formData, "description"),
      team: optionalFormString(formData, "team"),
      priority: formInteger(formData, "priority"),
      assignee: nullableFormString(formData, "assignee"),
      project: nullableFormString(formData, "project"),
      labels: labels.length > 0 ? labels : undefined
    })
  );

  return createIssueAction(input);
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

export async function updateIssueDetailFieldsAction(formData: FormData) {
  const identifier = requiredFormString(formData, "identifier");
  const input = updateIssueInputSchema.parse({
    title: requiredFormString(formData, "title"),
    description: nullableFormString(formData, "description"),
    priority: formInteger(formData, "priority")
  });

  await updateIssueAction(identifier, input);
}

export async function moveIssueDetailAction(formData: FormData) {
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

export async function assignIssueDetailAction(formData: FormData) {
  const identifier = requiredFormString(formData, "identifier");
  const requestedActor = requiredFormString(formData, "actor");

  withTrackerContext((context) => {
    const actor =
      requestedActor === "--none"
        ? null
        : requestedActor === "--me"
          ? requireCurrentActorHandle(context)
          : requestedActor;
    const input = assignIssueInputSchema.parse({ identifier, actor });

    assignIssue(context, input.identifier, input.actor);
  });
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

export async function addIssueCommentAction(formData: FormData) {
  const input = addCommentInputSchema.parse({
    issue: requiredFormString(formData, "identifier"),
    body: requiredFormString(formData, "body"),
    parent: nullableFormString(formData, "parent")
  });

  withTrackerContext((context) => {
    addComment(context, input);
  });
}

export async function updateIssueLabelAction(formData: FormData) {
  const identifier = requiredFormString(formData, "identifier");
  const labelId = requiredFormString(formData, "labelId");
  const operation = requiredFormString(formData, "operation");
  const input = updateIssueInputSchema.parse(
    operation === "add" ? { labels: [labelId] } : { removeLabels: [labelId] }
  );

  if (operation !== "add" && operation !== "remove") {
    throw new Error(`Unsupported label operation ${operation}.`);
  }

  await updateIssueAction(identifier, input);
}

export async function addAttachmentAction(input: AddAttachmentInput) {
  return withTrackerContext((context) => serializeAttachment(addAttachment(context, input)));
}

function formString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function requiredFormString(formData: FormData, key: string): string {
  return formString(formData.get(key)).trim();
}

function nullableFormString(formData: FormData, key: string): string | null {
  const value = formString(formData.get(key)).trim();
  return value.length > 0 ? value : null;
}

function optionalFormString(formData: FormData, key: string): string | undefined {
  const value = formString(formData.get(key)).trim();
  return value.length > 0 ? value : undefined;
}

function formStrings(values: FormDataEntryValue[]): string[] {
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function formInteger(formData: FormData, key: string): number {
  return Number.parseInt(requiredFormString(formData, key), 10);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Partial<T>;
}

function requireCurrentActorHandle(context: Parameters<typeof assignIssue>[0]): string {
  if (!context.actor) {
    throw new Error("A current actor is required to assign an issue to --me.");
  }

  return context.actor.handle;
}
