import { z } from "zod";

import type { AddAttachmentInput, ListAttachmentsInput } from "../services/attachment.js";
import { nonEmptyStringSchema, optionalNullableStringSchema } from "./common.js";

const attachmentBaseSchema = z.object({
  issue: nonEmptyStringSchema,
  title: optionalNullableStringSchema,
  remote: optionalNullableStringSchema
});

export const attachmentKindSchema = z.enum(["link", "branch", "pr", "commit"]);

export const linkIssueInputSchema = z.discriminatedUnion("kind", [
  attachmentBaseSchema.extend({
    kind: z.literal("link"),
    url: nonEmptyStringSchema,
    repoPath: optionalNullableStringSchema,
    branchName: optionalNullableStringSchema,
    commitSha: optionalNullableStringSchema
  }),
  attachmentBaseSchema.extend({
    kind: z.literal("branch"),
    repoPath: nonEmptyStringSchema,
    branchName: nonEmptyStringSchema,
    url: optionalNullableStringSchema,
    commitSha: optionalNullableStringSchema
  }),
  attachmentBaseSchema.extend({
    kind: z.literal("pr"),
    repoPath: nonEmptyStringSchema,
    url: nonEmptyStringSchema,
    branchName: optionalNullableStringSchema,
    commitSha: optionalNullableStringSchema
  }),
  attachmentBaseSchema.extend({
    kind: z.literal("commit"),
    repoPath: nonEmptyStringSchema,
    commitSha: nonEmptyStringSchema,
    url: optionalNullableStringSchema,
    branchName: optionalNullableStringSchema
  })
]) satisfies z.ZodType<AddAttachmentInput>;

export const linkIssueToolInputSchema = z.object({
  issue: nonEmptyStringSchema,
  kind: attachmentKindSchema,
  title: optionalNullableStringSchema,
  url: optionalNullableStringSchema,
  repoPath: optionalNullableStringSchema,
  remote: optionalNullableStringSchema,
  branchName: optionalNullableStringSchema,
  commitSha: optionalNullableStringSchema
});

export const listAttachmentsInputSchema = z.object({
  issue: nonEmptyStringSchema
}) satisfies z.ZodType<ListAttachmentsInput>;
