import { z } from "zod";
import { nonEmptyStringSchema } from "./common.js";
export const detailFieldSchema = z.enum(["id", "identifier", "revision", "teamId", "number", "title", "description", "stateId", "priority", "assigneeId", "creatorId", "projectId", "cycleId", "parentId", "parent", "children", "blockedBy", "blocks", "comments", "commentCount", "attachments", "estimate", "dueDate", "sortOrder", "createdAt", "updatedAt", "startedAt", "completedAt", "canceledAt", "archivedAt", "labels"]);
export const detailBudgetSchema = z.number().int().min(1024).max(65536);
export const detailPathSchema = z.array(z.union([z.string().min(1).max(50), z.number().int().nonnegative()])).min(1).max(6);
export const readIssueSectionInputSchema = z.strictObject({
  identifier: nonEmptyStringSchema,
  path: detailPathSchema.describe("Section path, e.g. [description], [comments], or [comments,0,body]. Use omittedPaths to retrieve oversized values."),
  cursor: z.string().max(4096).optional(),
  snapshot: z.string().optional().describe("Require the snapshot returned by a prior bounded read."),
  limit: z.number().int().min(1).max(100).default(25),
  maxBytes: detailBudgetSchema.default(16384)
});
export const getIssuesInputSchema = z.strictObject({
  identifiers: z.array(nonEmptyStringSchema).min(1).max(10),
  fields: z.array(detailFieldSchema).optional(),
  maxBytes: z.number().int().min(8192).max(65536).default(16384)
});
