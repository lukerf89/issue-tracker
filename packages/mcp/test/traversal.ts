import { expect } from "vitest";

/** Any tool caller that returns the parsed JSON text payload as `data`. */
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<{ data: ReturnType<typeof JSON.parse> }>;

type SectionPage = { data: { value: unknown; omittedPaths: unknown[]; nextCursor: string | null } };

/** Follows read_issue_section's nextCursor over a collection until it is exhausted; returns every entry. */
export async function walkSection(call: ToolCaller, identifier: string, path: Array<string | number>, limit: number, maxBytes = 4096) {
  const entries: unknown[] = [];
  let cursor: string | undefined;
  let last: SectionPage | undefined;
  do {
    last = await call("read_issue_section", { identifier, path, cursor, limit, maxBytes }) as SectionPage;
    entries.push(...(last.data.value as unknown[]));
    cursor = last.data.nextCursor ?? undefined;
  } while (cursor);
  expect(last!.data.nextCursor).toBeNull();
  return entries;
}

/** Follows read_issue_section's nextCursor over a string value, concatenating every chunk. */
export async function readSectionText(call: ToolCaller, identifier: string, path: Array<string | number>, maxBytes = 4096) {
  let text = "";
  let cursor: string | undefined;
  do {
    const page = await call("read_issue_section", { identifier, path, cursor, maxBytes }) as SectionPage;
    expect(typeof page.data.value, JSON.stringify(page.data).slice(0, 200)).toBe("string");
    text += page.data.value as string;
    cursor = page.data.nextCursor ?? undefined;
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
 * `between` runs after each page (used to mutate during a traversal).
 */
export async function walkPages(call: ToolCaller, tool: "list_issues" | "search", args: Record<string, unknown>, options: { cursor?: string; between?: (page: number, identifiers: string[]) => Promise<void> | void } = {}): Promise<PageWalk> {
  const identifiers: string[] = [];
  let cursor = options.cursor;
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
    await options.between?.(pages, identifiers);
  }
}

type ValuePage = { data: { value: unknown; omittedPaths: Array<Array<string | number>>; nextCursor: string | null; error?: unknown } };
const samePath = (a: Array<string | number>, b: Array<string | number>) => a.length === b.length && a.every((part, index) => part === b[index]);

/**
 * The complete-content path: rebuilds a section byte-for-byte from bounded read_issue_section
 * pages, following nextCursor and descending into every omittedPath (oversized entries or fields).
 */
export async function readComplete(call: ToolCaller, identifier: string, path: Array<string | number>, maxBytes = 4096, limit = 5): Promise<unknown> {
  const first = await call("read_issue_section", { identifier, path, maxBytes, limit }) as ValuePage;
  expect(first.data.error, JSON.stringify(first.data.error)).toBeUndefined();
  if (typeof first.data.value === "string") {
    let text = first.data.value;
    let cursor = first.data.nextCursor ?? undefined;
    while (cursor) {
      const page = await call("read_issue_section", { identifier, path, cursor, maxBytes }) as ValuePage;
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
      page = await call("read_issue_section", { identifier, path, cursor: page.data.nextCursor, maxBytes, limit }) as ValuePage;
    }
  }
  const value = { ...(first.data.value as Record<string, unknown>) };
  for (const omitted of first.data.omittedPaths) {
    value[String(omitted.at(-1))] = await readComplete(call, identifier, omitted, maxBytes, limit);
  }
  return value;
}
