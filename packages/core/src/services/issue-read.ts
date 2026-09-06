import { z } from "zod";
import type { ServiceContext } from "../context.js";
import { AppError, AppErrorCode } from "../errors.js";
import { getIssueInputSchema } from "../schemas/issue.js";
import { getIssuesInputSchema, readIssueSectionInputSchema } from "../schemas/issue-read.js";
import { serializeIssue } from "../serialize.js";
import { fingerprint } from "./issue-cursor.js";
import { getIssue } from "./issue.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
type Path = Array<string | number>;
function source(context: ServiceContext, identifier: string) {
  const data = serializeIssue(getIssue(context, identifier, { comments: "all" }));
  return { data, snapshot: fingerprint(data) };
}
function selection(context: ServiceContext, identifier: string, fields: string[] | undefined, maxBytes: number) {
  const { data, snapshot } = source(context, identifier);
  const wanted = [...new Set(fields ?? Object.keys(data))];
  const result = { identifier, revision: data.revision, snapshot, data: {} as Record<string, unknown>, omittedFields: [...wanted], sectionTool: "read_issue_section" };
  for (const field of wanted) {
    result.data[field] = data[field as keyof typeof data];
    result.omittedFields = result.omittedFields.filter((key) => key !== field);
    if (bytes(result) > maxBytes) {
      delete result.data[field];
      result.omittedFields.push(field);
    }
  }
  result.omittedFields.sort();
  if (bytes(result) > maxBytes) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Budget cannot fit retrieval metadata; increase maxBytes.");
  return result;
}

export function getIssueResponse(context: ServiceContext, input: z.input<typeof getIssueInputSchema>) {
  const parsed = getIssueInputSchema.parse(input);
  return context.db.transaction((db) => {
    const tx = { ...context, db };
    return parsed.fields !== undefined || parsed.maxBytes !== undefined
      ? selection(tx, parsed.identifier, parsed.fields, parsed.maxBytes ?? 16384)
      : serializeIssue(getIssue(tx, parsed.identifier, parsed));
  });
}

export function getIssuesResponse(context: ServiceContext, input: z.input<typeof getIssuesInputSchema>) {
  const parsed = getIssuesInputSchema.parse(input);
  return context.db.transaction((db) => ({
    issues: parsed.identifiers.map((identifier) => selection({ ...context, db }, identifier, parsed.fields, Math.floor((parsed.maxBytes - 128) / parsed.identifiers.length)))
  }));
}

const cursorSchema = z.strictObject({ snapshot: z.string(), path: z.string(), offset: z.number().int().nonnegative() });
export function readIssueSection(context: ServiceContext, input: z.input<typeof readIssueSectionInputSchema>) {
  const parsed = readIssueSectionInputSchema.parse(input);
  return context.db.transaction((db) => {
    const { data, snapshot } = source({ ...context, db }, parsed.identifier);
    if (parsed.snapshot && parsed.snapshot !== snapshot) throw stale();
    let value: unknown = data;
    for (const part of parsed.path) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part) || ["__proto__", "constructor", "prototype"].includes(String(part))) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Unknown section path.", { path: parsed.path });
      value = (value as Record<string | number, unknown>)[part];
    }
    const pathKey = JSON.stringify([parsed.identifier, parsed.path]);
    let offset = 0;
    if (parsed.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try {
        if (!/^is1\.[A-Za-z0-9_-]+$/.test(parsed.cursor)) throw new Error();
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(parsed.cursor.slice(4), "base64url").toString()));
        if (cursor.path !== pathKey) throw new Error();
      } catch { throw new AppError(AppErrorCode.VALIDATION_FAILED, "Invalid section cursor or path. Restart this section."); }
      if (cursor.snapshot !== snapshot) throw stale();
      offset = cursor.offset;
    }
    const next = (offset: number) => "is1." + Buffer.from(JSON.stringify({ snapshot, path: pathKey, offset })).toString("base64url");
    const result = { identifier: parsed.identifier, revision: data.revision, snapshot, path: parsed.path, value: null as unknown, omittedPaths: [] as Path[], nextCursor: null as string | null };
    if (typeof value === "string") {
      if (offset > value.length) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Section cursor is out of range.");
      let low = offset, high = value.length;
      while (low < high) {
        const end = Math.ceil((low + high) / 2);
        result.value = value.slice(offset, end); result.nextCursor = end < value.length ? next(end) : null;
        if (bytes(result) <= parsed.maxBytes) low = end; else high = end - 1;
      }
      if (low < value.length && low > offset && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low--;
      result.value = value.slice(offset, low); result.nextCursor = low < value.length ? next(low) : null;
      if (low === offset && offset < value.length) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Increase maxBytes to fit section metadata.");
    } else if (Array.isArray(value)) {
      if (offset > value.length) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Section cursor is out of range.");
      const entries: unknown[] = []; result.value = entries;
      let index = offset;
      for (; index < value.length && entries.length < parsed.limit; index++) {
        entries.push(value[index]); result.nextCursor = index + 1 < value.length ? next(index + 1) : null;
        if (bytes(result) > parsed.maxBytes) {
          entries[entries.length - 1] = null;
          result.omittedPaths.push([...parsed.path, index]);
          if (bytes(result) > parsed.maxBytes) { entries.pop(); result.omittedPaths.pop(); break; }
        }
      }
      if (index === offset && index < value.length) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Increase maxBytes to fit section metadata.");
      result.nextCursor = index < value.length ? next(index) : null;
    } else if (value !== null && typeof value === "object") {
      const entries: Record<string, unknown> = {}; result.value = entries;
      for (const [key, entry] of Object.entries(value)) {
        entries[key] = entry;
        if (bytes(result) > parsed.maxBytes - 256) { delete entries[key]; result.omittedPaths.push([...parsed.path, key]); }
      }
    } else result.value = value;
    if (bytes(result) > parsed.maxBytes) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Increase maxBytes to fit section metadata.");
    return result;
  });
}
function stale() { return new AppError(AppErrorCode.ISSUE_CURSOR_STALE, "Issue content changed. Read a fresh selection before continuing this section."); }
