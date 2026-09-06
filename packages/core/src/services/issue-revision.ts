import { eq, or } from "drizzle-orm";
import type { ServiceContext } from "../context.js";
import { issues } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";

export interface IssueWriteOptions { expectedRevision?: number; }

export function assertIssueRevision(context: ServiceContext, reference: string, expectedRevision?: number) {
  if (expectedRevision === undefined) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new AppError(AppErrorCode.VALIDATION_FAILED, "expectedRevision must be a positive safe integer.");
  }
  const issue = context.db.query.issues.findFirst({ where: or(eq(issues.id, reference), eq(issues.identifier, reference)) }).sync();
  if (!issue) throw new AppError(AppErrorCode.ISSUE_NOT_FOUND, `Issue ${reference} was not found.`);
  if (issue.revision !== expectedRevision) throw new AppError(AppErrorCode.ISSUE_CONFLICT, "Issue changed; read the current revision before retrying.", { identifier: issue.identifier, expectedRevision, currentRevision: issue.revision });
}
