import { asc, eq } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { actors, comments, issues, type Actor, type Comment, type Issue } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { appendActivityInTransaction } from "./activity.js";

export interface AddCommentInput {
  issue: string;
  body: string;
  parent?: string | null;
}

export interface ListCommentsInput {
  issue: string;
}

export type CommentWithAuthor = Comment & { author: Actor };

export function addComment(context: ServiceContext, input: AddCommentInput): CommentWithAuthor {
  requireActor(context);

  return inTransaction(context, (txContext) => {
    const actor = requireActor(txContext);
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
      createdAt: now
    };

    txContext.db.insert(comments).values(row).run();
    touchIssue(txContext, issue.id, now);
    appendActivityInTransaction(txContext, {
      issueId: issue.id,
      actorId: actor.id,
      action: "commented",
      data: { commentId: row.id, parentId: row.parentId }
    });

    return getCommentWithAuthor(txContext, row.id);
  });
}

export function listComments(
  context: ServiceContext,
  input: ListCommentsInput
): CommentWithAuthor[] {
  const issue = getIssueByIdOrIdentifier(context, input.issue);

  return commentRowsWithAuthors(context, issue.id);
}

function commentRowsWithAuthors(context: ServiceContext, issueId: string): CommentWithAuthor[] {
  return context.db
    .select({
      id: comments.id,
      issueId: comments.issueId,
      authorId: comments.authorId,
      body: comments.body,
      parentId: comments.parentId,
      createdAt: comments.createdAt,
      authorType: actors.type,
      authorName: actors.name,
      authorHandle: actors.handle,
      authorArchivedAt: actors.archivedAt
    })
    .from(comments)
    .innerJoin(actors, eq(actors.id, comments.authorId))
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all()
    .map((row) => ({
      id: row.id,
      issueId: row.issueId,
      authorId: row.authorId,
      body: row.body,
      parentId: row.parentId,
      createdAt: row.createdAt,
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
