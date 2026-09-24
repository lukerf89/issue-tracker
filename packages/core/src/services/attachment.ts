import { assertIssueRevision, type IssueWriteOptions } from "./issue-revision.js";
import { asc, eq } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { attachments, issues, type Attachment, type Issue } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { appendActivityInTransaction } from "./activity.js";
import {
  idempotencyConflict,
  isIdempotencyUniqueViolation,
  mismatchedFields,
  normalizeIdempotencyKey
} from "./idempotency.js";

export type AttachmentKind = Attachment["kind"];

export interface AddAttachmentInput extends IssueWriteOptions {
  issue: string;
  kind: AttachmentKind;
  title?: string | null;
  url?: string | null;
  repoPath?: string | null;
  remote?: string | null;
  branchName?: string | null;
  commitSha?: string | null;
  // Optional retry key, global to the attachments table. Trimmed; blank means "no key".
  idempotencyKey?: string | null;
}

export interface ListAttachmentsInput {
  issue: string;
}

// `alreadyExisted` is true when an idempotency key matched a prior attachment with the same
// payload; nothing was written and no revision check ran.
export type AddAttachmentResult = Attachment & { alreadyExisted: boolean };

// Attachments have no author column, so the actor is not part of the compared payload.
const ATTACHMENT_KEY_FIELDS = [
  "issueId",
  "kind",
  "title",
  "url",
  "repoPath",
  "remote",
  "branchName",
  "commitSha"
] as const;

export function addAttachment(
  context: ServiceContext,
  input: AddAttachmentInput
): AddAttachmentResult {
  requireActor(context);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  return inTransaction(context, (txContext) => {
    const actor = requireActor(txContext);

    // A key match takes precedence over required-field, revision and issue checks: the
    // retry either replays the stored attachment or conflicts.
    if (idempotencyKey !== null) {
      const existing = findAttachmentByIdempotencyKey(txContext, idempotencyKey);
      if (existing) {
        return replayOrConflict(txContext, existing, idempotencyKey, input);
      }
    }

    assertRequiredFields(input);
    assertIssueRevision(txContext, input.issue, input.expectedRevision);
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
      createdAt: now,
      idempotencyKey
    };

    try {
      txContext.db.insert(attachments).values(row).run();
    } catch (error) {
      // Defense-in-depth: IMMEDIATE transactions serialize writers, but if a concurrent
      // writer won the key, apply the same replay-or-conflict rule to the winner.
      if (
        idempotencyKey !== null &&
        isIdempotencyUniqueViolation(error, "attachments.idempotency_key")
      ) {
        const winner = findAttachmentByIdempotencyKey(txContext, idempotencyKey);
        if (winner) {
          return replayOrConflict(txContext, winner, idempotencyKey, input);
        }
      }
      throw error;
    }

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

    return { ...getAttachmentById(txContext, row.id), alreadyExisted: false };
  });
}

function findAttachmentByIdempotencyKey(
  context: ServiceContext,
  key: string
): Attachment | undefined {
  return context.db.query.attachments.findFirst({
    where: eq(attachments.idempotencyKey, key)
  }).sync();
}

function replayOrConflict(
  context: ServiceContext,
  existing: Attachment,
  idempotencyKey: string,
  input: AddAttachmentInput
): AddAttachmentResult {
  // Lookup only: no revision check, and an unresolvable ref is an issueId mismatch rather
  // than ISSUE_NOT_FOUND. The title is compared after defaulting, so an explicit title equal
  // to the default replays.
  const incomingIssue = findIssueByIdOrIdentifier(context, input.issue);
  const incoming: Record<string, unknown> = {
    issueId: incomingIssue?.id ?? null,
    kind: input.kind,
    title: attachmentTitle(input),
    url: input.url ?? null,
    repoPath: input.repoPath ?? null,
    remote: input.remote ?? null,
    branchName: input.branchName ?? null,
    commitSha: input.commitSha ?? null
  };
  const stored: Record<string, unknown> = {
    issueId: existing.issueId,
    kind: existing.kind,
    title: existing.title,
    url: existing.url ?? null,
    repoPath: existing.repoPath ?? null,
    remote: existing.remote ?? null,
    branchName: existing.branchName ?? null,
    commitSha: existing.commitSha ?? null
  };
  const mismatched = mismatchedFields(stored, incoming, ATTACHMENT_KEY_FIELDS);

  if (mismatched.length > 0) {
    const existingIssue = findIssueByIdOrIdentifier(context, existing.issueId);
    throw idempotencyConflict({
      resource: "attachment",
      idempotencyKey,
      existingId: existing.id,
      issueIdentifier: existingIssue?.identifier ?? existing.issueId,
      mismatchedFields: mismatched
    });
  }

  return { ...existing, alreadyExisted: true };
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

function findIssueByIdOrIdentifier(
  context: ServiceContext,
  idOrIdentifier: string
): Issue | undefined {
  return (
    context.db.query.issues.findFirst({ where: eq(issues.id, idOrIdentifier) }).sync() ??
    context.db.query.issues.findFirst({ where: eq(issues.identifier, idOrIdentifier) }).sync()
  );
}

function getIssueByIdOrIdentifier(context: ServiceContext, idOrIdentifier: string): Issue {
  const issue = findIssueByIdOrIdentifier(context, idOrIdentifier);

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
