import { asc, eq } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { attachments, issues, type Attachment, type Issue } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { appendActivityInTransaction } from "./activity.js";

export type AttachmentKind = Attachment["kind"];

export interface AddAttachmentInput {
  issue: string;
  kind: AttachmentKind;
  title?: string | null;
  url?: string | null;
  repoPath?: string | null;
  remote?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
}

export interface ListAttachmentsInput {
  issue: string;
}

export function addAttachment(context: ServiceContext, input: AddAttachmentInput): Attachment {
  requireActor(context);
  assertRequiredFields(input);

  return inTransaction(context, (txContext) => {
    const actor = requireActor(txContext);
    const issue = getIssueByIdOrIdentifier(txContext, input.issue);
    const now = txContext.clock.now().toISOString();
    const row = {
      id: uuid(),
      issueId: issue.id,
      kind: input.kind,
      title: attachmentTitle(input),
      url: input.url ?? null,
      repoPath: input.repoPath ?? null,
      remote: input.remote ?? null,
      branchName: input.branchName ?? null,
      commitSha: input.commitSha ?? null,
      createdAt: now
    };

    txContext.db.insert(attachments).values(row).run();
    touchIssue(txContext, issue.id, now);
    appendActivityInTransaction(txContext, {
      issueId: issue.id,
      actorId: actor.id,
      action: "linked",
      data: {
        attachmentId: row.id,
        kind: row.kind,
        title: row.title,
        url: row.url,
        repoPath: row.repoPath,
        branchName: row.branchName,
        commitSha: row.commitSha
      }
    });

    return getAttachmentById(txContext, row.id);
  });
}

export function listAttachments(
  context: ServiceContext,
  input: ListAttachmentsInput
): Attachment[] {
  const issue = getIssueByIdOrIdentifier(context, input.issue);

  return context.db.query.attachments.findMany({
    where: eq(attachments.issueId, issue.id),
    orderBy: [asc(attachments.createdAt), asc(attachments.id)]
  }).sync();
}

function assertRequiredFields(input: AddAttachmentInput): void {
  switch (input.kind) {
    case "link":
      requireField(input, "url");
      return;
    case "branch":
      requireField(input, "repoPath");
      requireField(input, "branchName");
      return;
    case "pr":
      requireField(input, "repoPath");
      requireField(input, "url");
      return;
    case "commit":
      requireField(input, "repoPath");
      requireField(input, "commitSha");
      return;
  }
}

function requireField(input: AddAttachmentInput, field: keyof AddAttachmentInput): void {
  const value = input[field];

  if (typeof value === "string" && value.length > 0) {
    return;
  }

  throw new AppError(
    AppErrorCode.CONSTRAINT_VIOLATION,
    `Attachment kind ${input.kind} requires ${field}.`,
    { kind: input.kind, field }
  );
}

function attachmentTitle(input: AddAttachmentInput): string {
  if (input.title) return input.title;

  switch (input.kind) {
    case "link":
    case "pr":
      return input.url ?? input.kind;
    case "branch":
      return input.branchName ?? input.kind;
    case "commit":
      return input.commitSha ?? input.kind;
  }
}

function getAttachmentById(context: ServiceContext, id: string): Attachment {
  const attachment = context.db.query.attachments.findFirst({
    where: eq(attachments.id, id)
  }).sync();

  if (!attachment) {
    throw new AppError(
      AppErrorCode.CONSTRAINT_VIOLATION,
      `Attachment ${id} was not found after insert.`,
      { attachmentId: id }
    );
  }

  return attachment;
}

function getIssueByIdOrIdentifier(context: ServiceContext, idOrIdentifier: string): Issue {
  const issue =
    context.db.query.issues.findFirst({ where: eq(issues.id, idOrIdentifier) }).sync() ??
    context.db.query.issues.findFirst({ where: eq(issues.identifier, idOrIdentifier) }).sync();

  if (!issue) {
    throw new AppError(
      AppErrorCode.ISSUE_NOT_FOUND,
      `Issue ${idOrIdentifier} was not found.`,
      { identifier: idOrIdentifier }
    );
  }

  return issue;
}

function touchIssue(context: ServiceContext, issueId: string, updatedAt: string): void {
  context.db.update(issues).set({ updatedAt }).where(eq(issues.id, issueId)).run();
}

function requireActor(context: ServiceContext) {
  if (!context.actor) {
    throw new AppError(
      AppErrorCode.ACTOR_NOT_FOUND,
      "A service actor is required for this mutation."
    );
  }

  return context.actor;
}
