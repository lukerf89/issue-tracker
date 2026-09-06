import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, AppErrorCode } from "../errors.js";

const schema = z.strictObject({
  version: z.literal(1), kind: z.enum(["list", "search"]), query: z.string(),
  key: z.tuple([z.string(), z.number().int(), z.string()]).nullable(),
  value: z.union([z.string(), z.number(), z.null()]),
  offset: z.number().int().nonnegative(), snapshot: z.string().nullable()
});
export type IssueCursor = z.infer<typeof schema>;
export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function queryFingerprint(input: object): string {
  return fingerprint(Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== "limit" && value !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}
export function encodePageCursor(cursor: IssueCursor): string { return "it1." + Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
export function decodePageCursor(value: string | number | undefined, kind: IssueCursor["kind"], query: string): { legacyOffset: number; cursor: IssueCursor | null } {
  if (value === undefined) return { legacyOffset: 0, cursor: null };
  // Compatibility bridge: old offsets are accepted, but newly emitted cursors are opaque.
  if (typeof value === "number" || /^(0|[1-9]\d*)$/.test(value)) {
    const offset = Number(value);
    if (Number.isSafeInteger(offset) && offset >= 0) return { legacyOffset: offset, cursor: null };
  }
  if (typeof value === "string" && !value.startsWith("it1.")) throw new AppError(AppErrorCode.VALIDATION_FAILED, `Invalid cursor: ${value}`, { cursor: value });
  try {
    if (typeof value !== "string" || value.length > 4096 || !/^it1\.[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = schema.parse(JSON.parse(Buffer.from(value.slice(4), "base64url").toString()));
    if (cursor.kind !== kind || cursor.query !== query || (kind === "list" && !cursor.key)) throw new Error();
    return { legacyOffset: 0, cursor };
  } catch {
    throw new AppError(AppErrorCode.VALIDATION_FAILED, "Invalid or incompatible issue cursor. Restart with the same filters and no cursor.");
  }
}
export function assertCursorSnapshot(cursor: IssueCursor | null, snapshot: string | null) {
  if (cursor && cursor.snapshot !== snapshot) throw new AppError(AppErrorCode.ISSUE_CURSOR_STALE, "Results changed. Restart without a cursor and reconcile previously seen identifiers.");
}
