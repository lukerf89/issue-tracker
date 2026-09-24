import { expect } from "vitest";

/** Any tool caller that returns the parsed JSON text payload as `data`. */
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<{ data: ReturnType<typeof JSON.parse> }>;

/** Upper bound on pages any single traversal follows; far above every fixture's real page count. */
export const MAX_PAGES = 1000;

/**
 * Guards a cursor loop against hanging: call it with every cursor the loop is about to follow.
 * Throws if the walk exceeds `maxPages` or a cursor repeats (the server made no progress).
 */
export function cursorGuard(label: string, maxPages = MAX_PAGES) {
  const seen = new Set<string>();
  return (cursor: unknown) => {
    const key = JSON.stringify(cursor);
    if (seen.has(key)) throw new Error(`${label}: cursor ${key} repeated after ${seen.size} pages (no progress)`);
    seen.add(key);
    if (seen.size >= maxPages) throw new Error(`${label}: exceeded ${maxPages} pages without exhausting the cursor`);
  };
}

type SectionPage = { data: { value: unknown; omittedPaths: Array<Array<string | number>>; nextCursor: string | null } };

/** One read_issue_section page; any error envelope, on any page, fails with its code and message. */
async function sectionPage(call: ToolCaller, args: Record<string, unknown>): Promise<SectionPage> {
  const page = await call("read_issue_section", args);
  const error = page.data?.error as { code: string; message: string } | undefined;
  if (error) throw new Error(`read_issue_section ${JSON.stringify(args.path)} failed: ${error.code}: ${error.message}`);
  return page as SectionPage;
}

/** Follows read_issue_section's nextCursor over a collection until it is exhausted; returns every entry. */
export async function walkSection(call: ToolCaller, identifier: string, path: Array<string | number>, limit: number, maxBytes = 4096) {
  const guard = cursorGuard(`walkSection ${identifier} ${JSON.stringify(path)}`);
  const entries: unknown[] = [];
  let cursor: string | undefined;
  let last: SectionPage | undefined;
  do {
    last = await sectionPage(call, { identifier, path, cursor, limit, maxBytes });
    entries.push(...(last.data.value as unknown[]));
    cursor = last.data.nextCursor ?? undefined;
    if (cursor !== undefined) guard(cursor);
  } while (cursor);
  expect(last!.data.nextCursor).toBeNull();
  return entries;
}

/** Follows read_issue_section's nextCursor over a string value, concatenating every chunk. */
export async function readSectionText(call: ToolCaller, identifier: string, path: Array<string | number>, maxBytes = 4096) {
  const guard = cursorGuard(`readSectionText ${identifier} ${JSON.stringify(path)}`);
  let text = "";
  let cursor: string | undefined;
  do {
    const page = await sectionPage(call, { identifier, path, cursor, maxBytes });
    expect(typeof page.data.value, JSON.stringify(page.data).slice(0, 200)).toBe("string");
    text += page.data.value as string;
    cursor = page.data.nextCursor ?? undefined;
    if (cursor !== undefined) guard(cursor);
  } while (cursor);
  return text;
}

export interface PageWalk {
  pages: number;
  identifiers: string[];
  /** The stale-cursor error when the traversal was explicitly invalidated mid-walk. */
  staleAt?: { page: number; error: { code: string; message: string } };
}

/**
 * Follows nextCursor over list_issues/search from `cursor` (or the start). An ISSUE_CURSOR_STALE
 * error ends the walk and is reported, never thrown; any other error fails the test.
 */
export async function walkPages(call: ToolCaller, tool: "list_issues" | "search", args: Record<string, unknown>, options: { cursor?: string } = {}): Promise<PageWalk> {
  const guard = cursorGuard(`walkPages ${tool}`);
  const identifiers: string[] = [];
  let cursor = options.cursor;
  if (cursor !== undefined) guard(cursor);
  let pages = 0;
  for (;;) {
    const result = await call(tool, cursor === undefined ? args : { ...args, cursor });
    if (result.data?.error) {
      expect(result.data.error.code, JSON.stringify(result.data.error)).toBe("ISSUE_CURSOR_STALE");
      return { pages, identifiers, staleAt: { page: pages + 1, error: result.data.error } };
    }
    pages += 1;
    identifiers.push(...(result.data.issues as Array<{ identifier: string }>).map((row) => row.identifier));
    cursor = result.data.nextCursor ?? undefined;
    if (cursor === undefined) return { pages, identifiers };
    guard(cursor);
  }
}

const samePath = (a: Array<string | number>, b: Array<string | number>) => a.length === b.length && a.every((part, index) => part === b[index]);

/**
 * The complete-content path: rebuilds a section byte-for-byte from bounded read_issue_section
 * pages, following nextCursor and descending into every omittedPath (oversized entries or fields).
 */
export async function readComplete(call: ToolCaller, identifier: string, path: Array<string | number>, maxBytes = 4096, limit = 5): Promise<unknown> {
  const guard = cursorGuard(`readComplete ${identifier} ${JSON.stringify(path)}`);
  const first = await sectionPage(call, { identifier, path, maxBytes, limit });
  if (first.data.value === null) return null;
  if (typeof first.data.value === "string") {
    let text = first.data.value;
    let cursor = first.data.nextCursor ?? undefined;
    while (cursor) {
      guard(cursor);
      const page = await sectionPage(call, { identifier, path, cursor, maxBytes });
      text += page.data.value as string;
      cursor = page.data.nextCursor ?? undefined;
    }
    return text;
  }
  if (Array.isArray(first.data.value)) {
    const entries: unknown[] = [];
    let page = first;
    for (;;) {
      for (const entry of page.data.value as unknown[]) {
        const entryPath = [...path, entries.length];
        entries.push(page.data.omittedPaths.some((omitted) => samePath(omitted, entryPath))
          ? await readComplete(call, identifier, entryPath, maxBytes, limit)
          : entry);
      }
      if (!page.data.nextCursor) return entries;
      guard(page.data.nextCursor);
      page = await sectionPage(call, { identifier, path, cursor: page.data.nextCursor, maxBytes, limit });
    }
  }
  const value = { ...(first.data.value as Record<string, unknown>) };
  for (const omitted of first.data.omittedPaths) {
    value[String(omitted.at(-1))] = await readComplete(call, identifier, omitted, maxBytes, limit);
  }
  return value;
}
