import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createActor, createIssue, getIssue, moveIssue } from "@issue-tracker/core";
import { agentFixture } from "./agent-fixture.js";

// Executes AGENT_GUIDE.md: every recipe runs through the CLI and through MCP, each track on
// its own identically seeded fixture, and the two tracks must agree.

const guidePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../AGENT_GUIDE.md");
const guide = readFileSync(guidePath, "utf8");

type Track = "cli" | "mcp";
interface Step {
  recipe: string;
  track: Track;
  body: string;
  capture: Array<{ name: string; field: string }>;
  expectError: string | null;
  repeat: boolean;
}

function parseGuide(markdown: string): Step[] {
  const steps: Step[] = [];
  for (const match of markdown.matchAll(/^```(\w+) ([^\n]*recipe=[^\n]*)\n([\s\S]*?)^```$/gm)) {
    const attrs = new Map<string, string[]>();
    for (const token of match[2]!.trim().split(/\s+/)) {
      const [key, value] = token.split("=", 2) as [string, string];
      attrs.set(key, [...(attrs.get(key) ?? []), value]);
    }
    const track = attrs.get("track")?.[0];
    if (track !== "cli" && track !== "mcp") throw new Error(`bad track in ${match[2]}`);
    steps.push({
      recipe: attrs.get("recipe")![0]!,
      track,
      body: match[3]!.trim(),
      capture: (attrs.get("capture") ?? []).map((value) => {
        const [name, field] = value.split(":", 2) as [string, string];
        return { name, field };
      }),
      expectError: attrs.get("expect-error")?.[0] ?? null,
      repeat: attrs.get("repeat")?.[0] === "cursor"
    });
  }
  return steps;
}

/** Splits one CLI line on whitespace, honoring double quotes. */
function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

function fieldAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (current as Record<string, unknown> | null)?.[key], value);
}

function fillMcp(value: unknown, vars: Map<string, unknown>): unknown {
  if (typeof value === "string") {
    const placeholder = /^<([\w-]+)>$/.exec(value);
    if (placeholder) {
      if (!vars.has(placeholder[1]!)) throw new Error(`unbound placeholder ${value}`);
      return vars.get(placeholder[1]!);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => fillMcp(item, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillMcp(v, vars)]));
  return value;
}

function fillCli(words: string[], vars: Map<string, unknown>): string[] {
  return words.map((word) => {
    const placeholder = /^<([\w-]+)>$/.exec(word);
    if (!placeholder) return word;
    if (!vars.has(placeholder[1]!)) throw new Error(`unbound placeholder ${word}`);
    return String(vars.get(placeholder[1]!));
  });
}

const LONG_DESCRIPTION = "Pipeline notes for the fictional CI setup: lint, typecheck, test, build. ".repeat(80);

function seed(context: Awaited<ReturnType<typeof agentFixture>>["context"]) {
  createActor(context, { type: "agent", name: "Build Agent", handle: "build-agent" });
  createIssue(context, { title: "Set up CI", description: LONG_DESCRIPTION }); // ENG-1
  createIssue(context, { title: "CI cache warmup" }); // ENG-2
  createIssue(context, { title: "CI flaky retries", assignee: "build-agent" }); // ENG-3
  createIssue(context, { title: "Release notes draft" }); // ENG-4
  createIssue(context, { title: "CI dashboard" }); // ENG-5
  moveIssue(context, "ENG-5", "In Progress");
}

interface StepResult { error: boolean; data: unknown }
type RecipeResults = Map<string, StepResult[]>;

async function runTrack(track: Track, steps: Step[]) {
  const f = await agentFixture();
  const results: RecipeResults = new Map();
  try {
    seed(f.context);
    const vars = new Map<string, unknown>();
    for (const step of steps.filter((candidate) => candidate.track === track)) {
      const runs = results.get(step.recipe) ?? [];
      results.set(step.recipe, runs);
      do {
        let result: StepResult;
        if (track === "cli") {
          const words = shellWords(step.body);
          expect(words[0]).toBe("tracker");
          const args = fillCli(words.slice(1), vars);
          result = step.expectError
            ? { error: true, data: { error: f.cliError(args) } }
            : { error: false, data: JSON.parse(f.cli(args)) };
        } else {
          const { tool, arguments: args } = JSON.parse(step.body) as { tool: string; arguments: Record<string, unknown> };
          result = await f.call(tool, fillMcp(args, vars) as Record<string, unknown>);
        }
        if (step.expectError) {
          expect(result.error, step.body).toBe(true);
          expect((result.data as { error: { code: string } }).error.code, step.body).toBe(step.expectError);
        } else {
          expect(result.error, `${step.body}\n${JSON.stringify(result.data)}`).toBe(false);
        }
        for (const { name, field } of step.capture) vars.set(name, fieldAt(result.data, field));
        runs.push(result);
      } while (step.repeat && vars.get("cursor") != null);
    }
    const comments = getIssue(f.context, "ENG-1").comments;
    return { results, comments };
  } finally { await f.close(); }
}

/** Replaces values that differ between two fixtures (UUIDs, clock times, hashes, cursors). */
function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return "<uuid>";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return "<timestamp>";
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      ["snapshot", "nextCursor", "metadataRevision"].includes(key) && typeof entry === "string" ? `<${key}>` : normalize(entry)
    ]));
  }
  return value;
}

const steps = parseGuide(guide);
const identifiers = (data: unknown) => (data as { issues: Array<{ identifier: string }> }).issues.map((row) => row.identifier);

describe("AGENT_GUIDE.md", () => {
  it("is well-formed and follows its own bounded-read rules", () => {
    expect(steps.length).toBeGreaterThan(0);
    const recipes = [...new Set(steps.map((step) => step.recipe))];
    expect(recipes).toEqual(["discovery", "narrow-search", "selective-read", "mutation", "follow-up"]);
    for (const recipe of recipes) {
      const cli = steps.filter((step) => step.recipe === recipe && step.track === "cli");
      const mcp = steps.filter((step) => step.recipe === recipe && step.track === "mcp");
      expect(cli.length, recipe).toBeGreaterThan(0);
      expect(cli.map((step) => [step.expectError, step.repeat, step.capture]), recipe)
        .toEqual(mcp.map((step) => [step.expectError, step.repeat, step.capture]));
    }
    for (const step of steps) {
      if (step.track === "cli") {
        const words = shellWords(step.body);
        const command = words.slice(1, 3).join(" ");
        if (command === "issue list" || command === "issue search") {
          const limit = words.indexOf("--limit");
          expect(limit, step.body).toBeGreaterThan(0);
          expect(Number(words[limit + 1]), step.body).toBeLessThanOrEqual(25);
        }
        if (words[1] === "describe") expect(words, step.body).toContain("--sections");
      } else {
        const { tool, arguments: args } = JSON.parse(step.body) as { tool: string; arguments: Record<string, unknown> };
        if (tool === "list_issues" || tool === "search") expect(args.limit, step.body).toBeLessThanOrEqual(25);
        if (tool === "describe") expect(args.sections, step.body).toBeDefined();
      }
    }
    // The don'ts list names the unbounded forms; no runnable block may use them.
    expect(steps.some((step) => /issue list(?!.*--limit).*--json/.test(step.body))).toBe(false);
  });

  it("runs every recipe on the CLI and over MCP with the same outcomes", async () => {
    const cli = await runTrack("cli", steps);
    const mcp = await runTrack("mcp", steps);

    for (const { results, comments } of [cli, mcp]) {
      const [discovery] = results.get("discovery")!;
      const metadata = discovery!.data as Record<string, unknown>;
      expect(Object.keys(metadata).filter((key) => key !== "metadataRevision").sort()).toEqual(["priorities", "teams"]);
      expect((metadata.teams as Array<{ key: string }>).map((team) => team.key)).toEqual(["ENG"]);

      const [search] = results.get("narrow-search")!;
      expect(identifiers(search!.data).sort()).toEqual(["ENG-1", "ENG-2"]);
      for (const row of (search!.data as { issues: Array<Record<string, unknown>> }).issues) {
        expect(row).toMatchObject({ stateName: "Todo", revision: expect.any(Number) });
        expect(row).not.toHaveProperty("assigneeHandle");
        expect(row).not.toHaveProperty("description");
      }

      const [selection, section] = results.get("selective-read")!;
      const envelope = selection!.data as { data: Record<string, unknown>; omittedFields: string[] };
      expect(Buffer.byteLength(JSON.stringify(selection!.data))).toBeLessThanOrEqual(4096);
      expect(envelope.data).toEqual({ title: "Set up CI" });
      expect(envelope.omittedFields).toEqual(["description"]);
      expect(section!.data).toMatchObject({ value: LONG_DESCRIPTION, nextCursor: null });

      const [claim, comment, replay, reread, update, stale] = results.get("mutation")!;
      expect((claim!.data as { assigneeId: string | null }).assigneeId).toEqual(expect.any(String));
      expect(comment!.data).toMatchObject({ alreadyExisted: false });
      expect(replay!.data).toMatchObject({ alreadyExisted: true, id: (comment!.data as { id: string }).id });
      expect(comments).toHaveLength(1);
      const revision = (reread!.data as { revision: number }).revision;
      expect(update!.data).toMatchObject({ identifier: "ENG-1", changed: true, changedFields: ["title"], revision: revision + 1 });
      expect((stale!.data as { error: { details: unknown } }).error.details).toMatchObject({ expectedRevision: revision, currentRevision: revision + 1 });

      const pages = results.get("follow-up")!;
      expect(pages.length).toBeGreaterThan(1);
      const followed = pages.flatMap((page) => identifiers(page.data));
      expect(new Set(followed).size).toBe(followed.length);
      expect([...followed].sort()).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]);
      expect(followed[0]).toBe("ENG-1");
    }

    expect(normalize(Object.fromEntries(mcp.results))).toEqual(normalize(Object.fromEntries(cli.results)));
  });
});
