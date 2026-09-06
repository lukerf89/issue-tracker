import { z } from "zod";
import { inTransaction, type ServiceContext } from "../context.js";
import { serializeIssue } from "../serialize.js";
import { getIssue, type IssueWithDetails } from "./issue.js";

export const issueResponseSchema = z.enum(["full", "compact"]).default("full");
export interface IssueReceipt {
  identifier: string;
  changed: boolean;
  changedFields: string[];
  updatedAt: string;
  revision: number;
  alreadyExisted: boolean | null;
}
export type IssueWithReceipt = IssueWithDetails & { alreadyExisted?: boolean; mutationReceipt?: IssueReceipt };

/** Capture before/after under the same write transaction, including idempotent creates. */
export function withIssueMutationReceipt<T extends IssueWithReceipt>(context: ServiceContext, identifier: string | null, work: (context: ServiceContext) => T): T {
  return inTransaction(context, (tx) => {
    const before = identifier === null ? null : serializeIssue(getIssue(tx, identifier));
    const result = work(tx);
    const after = serializeIssue(result);
    const ignored = new Set(["updatedAt", "revision"]);
    const changedFields = result.alreadyExisted === true ? [] : Object.keys(after).filter((key) => !ignored.has(key) && (before === null || JSON.stringify(after[key as keyof typeof after]) !== JSON.stringify(before[key as keyof typeof before]))).sort();
    const receipt: IssueReceipt = { identifier: result.identifier, changed: changedFields.length > 0, changedFields, updatedAt: result.updatedAt, revision: result.revision, alreadyExisted: result.alreadyExisted ?? null };
    // Non-enumerable metadata keeps legacy callers and exports unchanged.
    Object.defineProperty(result, "mutationReceipt", { value: receipt });
    return result;
  });
}

export function serializeIssueMutation(issue: IssueWithReceipt, response: unknown = "full") {
  if (issueResponseSchema.parse(response) === "compact") {
    if (!issue.mutationReceipt) throw new Error("Mutation receipt was not captured.");
    return issue.mutationReceipt;
  }
  return { ...serializeIssue(issue), ...(issue.alreadyExisted === undefined ? {} : { alreadyExisted: issue.alreadyExisted }) };
}
