import { assertIssueRevision, type IssueWriteOptions } from "./issue-revision.js";
import { asc, eq, sql } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { actors, comments, issues, type Actor, type Comment, type Issue } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { appendActivityInTransaction } from "./activity.js";
import {
  idempotencyConflict,
  isIdempotencyUniqueViolation,
  mismatchedFields,
  normalizeIdempotencyKey
} from "./idempotency.js";

export interface AddCommentInput extends IssueWriteOptions {
  issue: string;
  body: string;
  parent?: string | null;
  // Optional retry key, global to the comments table. Trimmed; blank means "no key".
  idempotencyKey?: string | null;
}

export interface ListCommentsInput {
  issue: string;
}

export interface ListCommentsPageInput extends ListCommentsInput {
  offset?: number;
  limit?: number;
}

export type CommentWithAuthor = Comment & { author: Actor };

// `alreadyExisted` is true when an idempotency key matched a prior comment with the same
// payload; nothing was written and no revision check ran.
export type AddCommentResult = CommentWithAuthor & { alreadyExisted: boolean };

const COMMENT_KEY_FIELDS = ["issueId", "authorId", "body", "parentId"] as const;

export function addComment(context: ServiceContext, input: AddCommentInput): AddCommentResult {
  requireActor(context);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  return inTransaction(context, (txContext) => {
    const actor = requireActor(txContext);

    // A key match takes precedence over every other check (revision, issue existence,
    // parent validation): the retry either replays the stored comment or conflicts.
    if (idempotencyKey !== null) {
      const existing = findCommentByIdempotencyKey(txContext, idempotencyKey);
      if (existing) {
        return replayOrConflict(txContext, existing, idempotencyKey, input, actor.id);
      }
    }

    assertIssueRevision(txContext, input.issue, input.expectedRevision);
    const issue = getIssueByIdOrIdentifier(txContext, input.issue);
    const parent = input.parent == null ? null : getCommentById(txContext, input.parent);
    assertParentBelongsToIssue(issue, parent);

    const now = txContext.clock.now().toISOString();
    const row = {
      id: uuid(),
      issueId: issue.id,
      authorId: actor.id,
      body: input.body,
      parentId: parent?.id ?? null,
      createdAt: now,
      idempotencyKey
    };

    try {
      txContext.db.insert(comments).values(row).run();
    } catch (error) {
      // Defense-in-depth: IMMEDIATE transactions serialize writers, but if a concurrent
      // writer won the key, apply the same replay-or-conflict rule to the winner.
      if (
        idempotencyKey !== null &&
        isIdempotencyUniqueViolation(error, "comments.idempotency_key")
      ) {
        const winner = findCommentByIdempotencyKey(txContext, idempotencyKey);
        if (winner) {
          return replayOrConflict(txContext, winner, idempotencyKey, input, actor.id);
        }
      }
      throw error;
    }

    touchIssue(txContext, issue.id, now);
    appendActivityInTransaction(txContext, {
      issueId: issue.id,
      actorId: actor.id,
      action: "commented",
      data: { commentId: row.id, parentId: row.parentId }
    });

    return { ...getCommentWithAuthor(txContext, row.id), alreadyExisted: false };
  });
}

function findCommentByIdempotencyKey(
  context: ServiceContext,
  key: string
): Comment | undefined {
  return context.db.query.comments.findFirst({
    where: eq(comments.idempotencyKey, key)
  }).sync();
}

function replayOrConflict(
  context: ServiceContext,
  existing: Comment,
  idempotencyKey: string,
  input: AddCommentInput,
  actorId: string
): AddCommentResult {
  // Lookup only: no revision check, and an unresolvable ref is an issueId mismatch rather
  // than ISSUE_NOT_FOUND. Parent refs are always comment ids, so the raw id is canonical.
  const incomingIssue = findIssueByIdOrIdentifier(context, input.issue);
  const incoming = {
    issueId: incomingIssue?.id ?? null,
    authorId: actorId,
    body: input.body,
    parentId: input.parent ?? null
  };
  const stored = {
    issueId: existing.issueId,
    authorId: existing.authorId,
    body: existing.body,
    parentId: existing.parentId ?? null
  };
  const mismatched = mismatchedFields<Record<string, unknown>>(stored, incoming, COMMENT_KEY_FIELDS);

  if (mismatched.length > 0) {
    const existingIssue = findIssueByIdOrIdentifier(context, existing.issueId);
    throw idempotencyConflict({
      resource: "comment",
      idempotencyKey,
      existingId: existing.id,
      issueIdentifier: existingIssue?.identifier ?? existing.issueId,
      mismatchedFields: mismatched
    });
  }

  return { ...getCommentWithAuthor(context, existing.id), alreadyExisted: true };
}

export function listComments(
  context: ServiceContext,
  input: ListCommentsInput
): CommentWithAuthor[] {
  const issue = getIssueByIdOrIdentifier(context, input.issue);

  return commentRowsWithAuthors(context, issue.id);
}

export function countComments(context: ServiceContext, input: ListCommentsInput): number {
  const issue = getIssueByIdOrIdentifier(context, input.issue);
  return context.db
    .select({ count: sql<number>`count(*)` })
    .from(comments)
    .where(eq(comments.issueId, issue.id))
    .get()?.count ?? 0;
}

export function listCommentsPage(
  context: ServiceContext,
  input: ListCommentsPageInput
): CommentWithAuthor[] {
  const issue = getIssueByIdOrIdentifier(context, input.issue);
  return commentRowsWithAuthors(context, issue.id, input);
}

function commentRowsWithAuthors(
  context: ServiceContext,
  issueId: string,
  options: Pick<ListCommentsPageInput, "limit" | "offset"> = {}
): CommentWithAuthor[] {
  let query = context.db
    .select({
      id: comments.id,
      issueId: comments.issueId,
      authorId: comments.authorId,
      body: comments.body,
      parentId: comments.parentId,
      createdAt: comments.createdAt,
      idempotencyKey: comments.idempotencyKey,
      authorType: actors.type,
      authorName: actors.name,
      authorHandle: actors.handle,
      authorArchivedAt: actors.archivedAt
    })
    .from(comments)
    .innerJoin(actors, eq(actors.id, comments.authorId))
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(comments.createdAt), asc(comments.id));

  if (options.limit !== undefined) {
    query = query.limit(options.limit) as typeof query;
  }
  if (options.offset !== undefined) {
    query = query.offset(options.offset) as typeof query;
  }

  return query.all()
    .map((row) => ({
      id: row.id,
      issueId: row.issueId,
      authorId: row.authorId,
      body: row.body,
      parentId: row.parentId,
      createdAt: row.createdAt,
      idempotencyKey: row.idempotencyKey,
      author: {
        id: row.authorId,
        type: row.authorType,
        name: row.authorName,
        handle: row.authorHandle,
        archivedAt: row.authorArchivedAt
      }
    }));
}

function getCommentWithAuthor(context: ServiceContext, id: string): CommentWithAuthor {
  const comment = commentRowsWithAuthors(context, getCommentById(context, id).issueId)
    .find((candidate) => candidate.id === id);

  if (!comment) {
    throw commentNotFound(id);
  }

  return comment;
}

function getCommentById(context: ServiceContext, id: string): Comment {
  const comment = context.db.query.comments.findFirst({
    where: eq(comments.id, id)
  }).sync();

  if (!comment) {
    throw commentNotFound(id);
  }

  return comment;
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

function assertParentBelongsToIssue(issue: Issue, parent: Comment | null): void {
  if (parent === null || parent.issueId === issue.id) {
    return;
  }

  throw new AppError(
    AppErrorCode.CONSTRAINT_VIOLATION,
    `Comment ${parent.id} does not belong to issue ${issue.identifier}.`,
    {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      commentId: parent.id,
      commentIssueId: parent.issueId
    }
  );
}

function touchIssue(context: ServiceContext, issueId: string, updatedAt: string): void {
  context.db.update(issues).set({ updatedAt }).where(eq(issues.id, issueId)).run();
}

function commentNotFound(id: string): AppError {
  return new AppError(AppErrorCode.COMMENT_NOT_FOUND, `Comment ${id} was not found.`, {
    comment: id
  });
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
