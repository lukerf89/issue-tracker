import { describe, expect, it } from "vitest";

import { addComment, archiveIssue, createIssue, createProject } from "@issue-tracker/core";

import { agentFixture } from "./agent-fixture.js";

// Fictional data only. LF-139: MCP bounded activity feed + paged history, with CLI parity.

describe("MCP activity feed and paged history", () => {
  it("serves list_activity_feed pages with filters and a continuation contract", async () => {
    const fx = await agentFixture();
    try {
      const empty = await fx.call("list_activity_feed", {});
      expect(empty).toEqual({ error: false, data: { events: [], cursor: "0", hasMore: false } });

      createProject(fx.context, { name: "Platform" });
      expect((await fx.call("create_issue", { title: "Set up CI", project: "Platform" })).error).toBe(false);
      expect((await fx.call("create_issue", { title: "Write docs" })).error).toBe(false);
      addComment(fx.context, { issue: "ENG-1", body: "Pipeline green" });

      const first = await fx.call("list_activity_feed", { limit: 2 });
      expect(first.error).toBe(false);
      expect(first.data.hasMore).toBe(true);
      expect(first.data.events.map((event: { issueIdentifier: string }) => event.issueIdentifier)).toEqual(["ENG-1", "ENG-2"]);
      expect(first.data.cursor).toBe(first.data.events[1].cursor);

      // Append during traversal; the next page picks it up exactly once.
      addComment(fx.context, { issue: "ENG-2", body: "Draft ready" });
      const second = await fx.call("list_activity_feed", { limit: 2, cursor: first.data.cursor });
      expect(second.data.events.map((event: { action: string }) => event.action)).toEqual(["commented", "commented"]);
      expect(second.data.hasMore).toBe(false);

      const scoped = await fx.call("list_activity_feed", { project: "Platform" });
      expect(scoped.data.events.map((event: { issueIdentifier: string }) => event.issueIdentifier)).toEqual(["ENG-1", "ENG-1"]);
      const byIssue = await fx.call("list_activity_feed", { issue: "ENG-2" });
      expect(byIssue.data.events).toHaveLength(2);

      const unknownIssue = await fx.call("list_activity_feed", { issue: "ENG-99" });
      expect(unknownIssue.error).toBe(true);
      expect(unknownIssue.data.error.code).toBe("ISSUE_NOT_FOUND");
    } finally {
      await fx.close();
    }
  });

  it("pages list_activity by default and keeps the legacy array behind full:true", async () => {
    const fx = await agentFixture();
    try {
      // Seed through the fixture's fixed clock so createdAt order equals append order here.
      createIssue(fx.context, { title: "Set up CI", team: "ENG" });
      for (let index = 0; index < 4; index += 1) {
        addComment(fx.context, { issue: "ENG-1", body: `Note ${index}` });
      }
      archiveIssue(fx.context, "ENG-1");

      const page = await fx.call("list_activity", { issue: "ENG-1", limit: 4 });
      expect(page.error).toBe(false);
      expect(Object.keys(page.data)).toEqual(["issue", "entries", "cursor", "hasMore"]);
      expect(page.data.issue.identifier).toBe("ENG-1");
      expect(page.data.entries).toHaveLength(4);
      expect(page.data.hasMore).toBe(true);
      const rest = await fx.call("list_activity", { issue: "ENG-1", after: page.data.cursor });
      expect(rest.data.entries.map((entry: { action: string }) => entry.action)).toEqual(["commented", "archived"]);
      expect(rest.data.hasMore).toBe(false);

      const full = await fx.call("list_activity", { issue: "ENG-1", full: true });
      expect(Array.isArray(full.data)).toBe(true);
      expect(full.data.map((entry: { action: string }) => entry.action)).toEqual([
        "created", "commented", "commented", "commented", "commented", "archived"
      ]);
      expect(Object.keys(full.data[0])).toEqual(["id", "issueId", "actorId", "actor", "action", "data", "createdAt"]);
      const pagedFirst = { ...page.data.entries[0] };
      expect(pagedFirst.cursor).toBe("1");
      delete pagedFirst.cursor;
      expect(pagedFirst).toEqual(full.data[0]);
    } finally {
      await fx.close();
    }
  });

  it("returns the structured error envelope for bad cursors and full+after/limit", async () => {
    const fx = await agentFixture();
    try {
      await fx.call("create_issue", { title: "Set up CI" });

      const malformed = await fx.call("list_activity_feed", { cursor: "abc" });
      expect(malformed.error).toBe(true);
      expect(malformed.data.error.code).toBe("VALIDATION_FAILED");

      const ahead = await fx.call("list_activity_feed", { cursor: "99" });
      expect(ahead.error).toBe(true);
      expect(ahead.data.error).toMatchObject({ code: "VALIDATION_FAILED", details: { cursor: "99", latestCursor: "1" } });

      const aheadHistory = await fx.call("list_activity", { issue: "ENG-1", after: "99" });
      expect(aheadHistory.data.error).toMatchObject({ code: "VALIDATION_FAILED", details: { after: "99", latestCursor: "1" } });

      for (const args of [{ full: true, after: "0" }, { full: true, limit: 5 }]) {
        const result = await fx.call("list_activity", { issue: "ENG-1", ...args });
        expect(result.error).toBe(true);
        expect(result.data.error.code).toBe("VALIDATION_FAILED");
        expect(fx.cliError(["issue", "history", "ENG-1", "--full", ...(args.after ? ["--after", args.after] : ["--limit", "5"])]).code)
          .toBe("VALIDATION_FAILED");
      }
      expect(fx.cliError(["activity", "--since", "99"])).toMatchObject({ code: "VALIDATION_FAILED", details: { cursor: "99", latestCursor: "1" } });
      expect(fx.cliError(["activity", "--limit", "501"]).code).toBe("VALIDATION_FAILED");
    } finally {
      await fx.close();
    }
  });

  it("matches CLI output byte for byte", async () => {
    const fx = await agentFixture();
    try {
      await fx.call("create_issue", { title: "Set up CI" });
      await fx.call("create_issue", { title: "Write docs" });
      addComment(fx.context, { issue: "ENG-1", body: "Pipeline green" });
      addComment(fx.context, { issue: "ENG-1", body: "Cache added" });

      const mcpText = async (name: string, args: Record<string, unknown>) => {
        const result = await fx.client.callTool({ name, arguments: args });
        return (result.content as Array<{ text: string }>)[0]!.text;
      };
      const parity: Array<[string, Record<string, unknown>, string[]]> = [
        ["list_activity_feed", {}, ["activity", "--json"]],
        ["list_activity_feed", { cursor: "1", limit: 2 }, ["activity", "--json", "--since", "1", "--limit", "2"]],
        ["list_activity_feed", { issue: "ENG-1", team: "ENG" }, ["activity", "--json", "--issue", "ENG-1", "--team", "ENG"]],
        ["list_activity", { issue: "ENG-1" }, ["issue", "history", "ENG-1", "--json"]],
        ["list_activity", { issue: "ENG-1", after: "1", limit: 1 }, ["issue", "history", "ENG-1", "--json", "--after", "1", "--limit", "1"]],
        ["list_activity", { issue: "ENG-1", full: true }, ["issue", "history", "ENG-1", "--json", "--full"]]
      ];
      for (const [tool, args, cli] of parity) {
        expect(fx.cli(cli), `${tool} ${JSON.stringify(args)}`).toBe(`${await mcpText(tool, args)}\n`);
      }

      // Human output may be colorized (CI=true enables picocolors); assert on plain text.
      const text = stripAnsi(fx.cli(["issue", "history", "ENG-1", "--limit", "1"]));
      expect(text).toContain("created");
      expect(text).toMatch(/next: 1\n$/);
      expect(stripAnsi(fx.cli(["issue", "history", "ENG-1"]))).not.toContain("next:");
    } finally {
      await fx.close();
    }
  });

  it("filters watch --once by issue", async () => {
    const fx = await agentFixture();
    try {
      await fx.call("create_issue", { title: "Set up CI" });
      await fx.call("create_issue", { title: "Write docs" });
      const lines = fx.cli(["watch", "--once", "--issue", "ENG-2"]).trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.map((line: { issueIdentifier: string }) => line.issueIdentifier)).toEqual(["ENG-2"]);
    } finally {
      await fx.close();
    }
  });
});

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);

  return value
    .split(escape)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-?]*[ -/]*[@-~]/, "")))
    .join("");
}
