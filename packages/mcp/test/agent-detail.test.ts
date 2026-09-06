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
