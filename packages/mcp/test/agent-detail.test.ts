import { expect, it } from "vitest";
import { addComment, createIssue, updateIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

it("bounds selections and reconstructs complete Unicode requirements through section pages", async () => {
  const f = await agentFixture();
  try {
    const description = "Acceptance criteria 🚀: preserve every character.\n".repeat(300);
    createIssue(f.context, { title: "Set up CI", description });
    const selected = await f.call("get_issue", { identifier: "ENG-1", fields: ["title", "description"], maxBytes: 1024 });
    expect(selected.error).toBe(false);
    expect(selected.data.data.title).toBe("Set up CI");
    expect(selected.data.omittedFields).toEqual(["description"]);
    expect(Buffer.byteLength(JSON.stringify(selected.data))).toBeLessThanOrEqual(1024);
    expect(JSON.parse(f.cli(["issue", "view", "ENG-1", "--fields", "title,description", "--max-bytes", "1024", "--json"]))).toEqual(selected.data);
    let cursor: string | undefined;
    let text = "";
    do {
      const page = await f.call("read_issue_section", { identifier: "ENG-1", path: ["description"], snapshot: selected.data.snapshot, cursor, maxBytes: 1024 });
      expect(page.error).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThanOrEqual(1024);
      text += page.data.value;
      cursor = page.data.nextCursor ?? undefined;
    } while (cursor);
    expect(text).toBe(description);
    expect((await f.call("get_issue", { identifier: "ENG-1", comments: "all" })).data.description).toBe(description);
    updateIssue(f.context, "ENG-1", { description: "Updated" });
    expect((await f.call("read_issue_section", { identifier: "ENG-1", path: ["description"], snapshot: selected.data.snapshot })).data.error.code).toBe("ISSUE_CURSOR_STALE");
  } finally { await f.close(); }
});

it("pages comments independently and exposes oversized nested values and bounded batches", async () => {
  const f = await agentFixture();
  try {
    for (let n = 0; n < 10; n++) createIssue(f.context, { title: `CI ${n}`, description: "Long text".repeat(2000) });
    for (let n = 0; n < 12; n++) addComment(f.context, { issue: "ENG-1", body: `Comment ${n}: ` + "detail ".repeat(1000) });
    const first = await f.call("read_issue_section", { identifier: "ENG-1", path: ["comments"], limit: 2, maxBytes: 2048 });
    expect(first.error).toBe(false);
    expect(first.data.omittedPaths).toEqual([["comments", 0], ["comments", 1]]);
    const comment = await f.call("read_issue_section", { identifier: "ENG-1", path: first.data.omittedPaths[0], maxBytes: 2048 });
    expect(comment.data.omittedPaths).toContainEqual(["comments", 0, "body"]);
    const body = await f.call("read_issue_section", { identifier: "ENG-1", path: ["comments", 0, "body"], maxBytes: 2048 });
    expect(body.data.value).toContain("Comment");
    expect(body.data.nextCursor).not.toBeNull();
    const next = await f.call("read_issue_section", { identifier: "ENG-1", path: ["comments"], cursor: first.data.nextCursor, limit: 2, maxBytes: 2048 });
    expect(next.data.omittedPaths[0]).toEqual(["comments", 2]);
    expect((await f.call("read_issue_section", { identifier: "ENG-1", path: ["attachments"] })).data.value).toEqual([]);
    expect((await f.call("read_issue_section", { identifier: "ENG-1", path: ["__proto__"] })).error).toBe(true);
    expect((await f.call("read_issue_section", { identifier: "ENG-1", path: ["description"], cursor: first.data.nextCursor })).error).toBe(true);
    const identifiers = Array.from({ length: 10 }, (_, n) => `ENG-${n + 1}`);
    const batch = await f.call("get_issues", { identifiers, fields: ["title", "description"], maxBytes: 8192 });
    expect(batch.error).toBe(false);
    expect(batch.data.issues).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(batch.data))).toBeLessThanOrEqual(8192);
    expect(JSON.parse(f.cli(["issue", "read-many", ...identifiers, "--fields", "title,description", "--max-bytes", "8192", "--json"]))).toEqual(batch.data);
    expect((await f.call("get_issues", { identifiers: [...identifiers, "ENG-11"] })).error).toBe(true);
  } finally { await f.close(); }
});

type SectionPage = { data: { value: unknown[]; omittedPaths: unknown[]; nextCursor: string | null } };

async function walkSection(f: Awaited<ReturnType<typeof agentFixture>>, identifier: string, path: Array<string | number>, limit: number) {
  const entries: unknown[] = [];
  let cursor: string | undefined;
  let last: SectionPage | undefined;
  do {
    last = await f.call("read_issue_section", { identifier, path, cursor, limit, maxBytes: 4096 }) as SectionPage;
    entries.push(...last.data.value);
    cursor = last.data.nextCursor ?? undefined;
  } while (cursor);
  expect(last!.data.nextCursor).toBeNull();
  return entries;
}

it("pages large relationship sections to completion", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Epic" });
    for (let n = 0; n < 5; n++) createIssue(f.context, { title: `Child ${n}`, parent: "ENG-1" });
    for (let n = 0; n < 3; n++) createIssue(f.context, { title: `Blocker ${n}`, blocks: ["ENG-1"] });
    const identifiers = (entries: unknown[]) => entries.map((entry) => (entry as { identifier: string }).identifier);
    expect(identifiers(await walkSection(f, "ENG-1", ["children"], 2))).toEqual(["ENG-2", "ENG-3", "ENG-4", "ENG-5", "ENG-6"]);
    expect(identifiers(await walkSection(f, "ENG-1", ["blockedBy"], 2))).toEqual(["ENG-7", "ENG-8", "ENG-9"]);
    expect(identifiers(await walkSection(f, "ENG-7", ["blocks"], 2))).toEqual(["ENG-1"]);
  } finally { await f.close(); }
});

it("walks every comment, canonicalizes string indexes, and matches the CLI", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Set up CI" });
    for (let n = 0; n < 12; n++) {
      f.context.clock = { now: () => new Date(Date.UTC(2026, 0, 2, 0, n)) };
      addComment(f.context, { issue: "ENG-1", body: `Comment ${n}` });
    }
    const comments = await walkSection(f, "ENG-1", ["comments"], 5);
    expect(comments.map((comment) => (comment as { body: string }).body)).toEqual(Array.from({ length: 12 }, (_, n) => `Comment ${n}`));

    const numeric = await f.call("read_issue_section", { identifier: "ENG-1", path: ["comments", 3, "body"] });
    const string = await f.call("read_issue_section", { identifier: "ENG-1", path: ["comments", "3", "body"] });
    expect(string.data).toEqual(numeric.data);
    expect(JSON.parse(f.cli(["issue", "read-section", "ENG-1", "--path", "comments.3.body", "--json"]))).toEqual(numeric.data);

    // The default latest view is truncated and points at the oldest comment.
    const latest = await f.call("get_issue", { identifier: "ENG-1" });
    expect(latest.data).toMatchObject({ hasMoreComments: true, nextCommentCursor: "0" });
    const oldest = await f.call("get_issue", { identifier: "ENG-1", commentCursor: latest.data.nextCommentCursor, commentLimit: 5 });
    expect(oldest.data.comments[0].body).toBe("Comment 0");
  } finally { await f.close(); }
});

it("stales section cursors on edits and rejects legacy comment options on bounded reads", async () => {
  const f = await agentFixture();
  try {
    createIssue(f.context, { title: "Set up CI" });
    for (let n = 0; n < 4; n++) addComment(f.context, { issue: "ENG-1", body: `Comment ${n}` });
    const first = await f.call("read_issue_section", { identifier: "ENG-1", path: ["comments"], limit: 2 });
    addComment(f.context, { issue: "ENG-1", body: "Late comment" });
    const stale = await f.call("read_issue_section", { identifier: "ENG-1", path: ["comments"], limit: 2, cursor: first.data.nextCursor });
    expect(stale.data.error.code).toBe("ISSUE_CURSOR_STALE");
    const mixed = await f.call("get_issue", { identifier: "ENG-1", fields: ["title"], comments: "all" });
    expect(mixed.data.error.code).toBe("VALIDATION_FAILED");
  } finally { await f.close(); }
});
