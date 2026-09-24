import { z } from "zod";

import { AppError, AppErrorCode } from "../errors.js";
import { runRecordCollectionSchema, type RunRecordCollection } from "../schemas/run.js";
import { queryFingerprint } from "./issue-cursor.js";

/**
 * Opaque keyset cursors for run lists and run record pages. Internal to core: adapters only pass
 * the string back. Cursors are LIVE (not snapshots): they carry the immutable sort key of the last
 * row returned, so a row that matches on every request is returned exactly once.
 */
const PREFIX = "rn1.";
const MAX_LENGTH = 4096;
const INVALID = "Invalid or incompatible run cursor. Restart with the same filters and no cursor.";

const timestamp = z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)));
const id = z.string().uuid();

export const recordKeySchemas = {
  repositories: z.tuple([z.number().int().nonnegative(), z.string().min(1)]),
  attempts: z.tuple([z.number().int().min(1), id]),
  participants: z.tuple([z.string().min(1), id]),
  artifacts: z.tuple([timestamp, id]),
  inputRequests: z.tuple([timestamp, id]),
  verifications: z.tuple([timestamp, id]),
  reviewFindings: z.tuple([timestamp, id]),
  pendingActions: z.tuple([timestamp, id])
} satisfies Record<RunRecordCollection, z.ZodType>;

export type RecordKey = [string | number, string];

const cursorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(1), kind: z.literal("runs"), query: z.string(), key: z.tuple([timestamp, id]) }),
  z.strictObject({ version: z.literal(1), kind: z.literal("records"), run: id, collection: runRecordCollectionSchema, key: z.tuple([z.union([z.string(), z.number()]), z.string()]) })
    .superRefine((cursor, context) => {
      if (!recordKeySchemas[cursor.collection].safeParse(cursor.key).success) context.addIssue({ code: "custom", path: ["key"], message: "key does not match collection" });
    })
]);
type RunCursor = z.infer<typeof cursorSchema>;

export function runListQuery(input: { issue?: string; state?: string; includeArchived?: boolean }): string {
  return queryFingerprint({ issue: input.issue, state: input.state, includeArchived: input.includeArchived === true ? true : undefined });
}

function encode(cursor: RunCursor): string { return PREFIX + Buffer.from(JSON.stringify(cursor)).toString("base64url"); }

function decode(value: string): RunCursor {
  try {
    if (value.length > MAX_LENGTH || !/^rn1\.[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    return cursorSchema.parse(JSON.parse(Buffer.from(value.slice(PREFIX.length), "base64url").toString()));
  } catch {
    throw invalid();
  }
}

function invalid() { return new AppError(AppErrorCode.VALIDATION_FAILED, INVALID); }

export function encodeRunListCursor(query: string, key: [string, string]): string { return encode({ version: 1, kind: "runs", query, key }); }

export function decodeRunListCursor(value: string | undefined, query: string): [string, string] | null {
  if (value === undefined) return null;
  const cursor = decode(value);
  if (cursor.kind !== "runs" || cursor.query !== query) throw invalid();
  return cursor.key;
}

export function encodeRunRecordCursor(run: string, collection: RunRecordCollection, key: RecordKey): string {
  return encode({ version: 1, kind: "records", run, collection, key });
}

export function decodeRunRecordCursor(value: string | undefined, run: string, collection: RunRecordCollection): RecordKey | null {
  if (value === undefined) return null;
  const cursor = decode(value);
  if (cursor.kind !== "records" || cursor.run !== run || cursor.collection !== collection) throw invalid();
  return cursor.key;
}
