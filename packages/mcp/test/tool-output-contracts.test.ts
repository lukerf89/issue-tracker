import { readFileSync } from "node:fs";

import {
  activityArraySchema, activityPageSchema, engineCatalogSchema, engineHealthFingerprint, errorEnvelopeSchema, exactOutputSchemas, issueMutationFullSchema, issueMutationReceiptSchema,
  issueSummaryPageSchema, runEventsPageSchema, runFullSchema, runRecordsPageSchema, runSummaryPageSchema, runSummarySchema, recordEngineHealth,
  toolContract, toolContractNames
} from "@issue-tracker/core";
import { describe, expect, it } from "vitest";

import { jsonErrorResult, mcpToolResult, toolResult } from "../src/tools/result.js";
import { contractFixture, type ToolCall } from "./contract-fixture.js";
import { readScenarios, writeScenarios } from "./tool-scenarios.js";

function expectStructured(name: string, result: ToolCall) {
  const contract = toolContract(name);
  expect(result.isError, `${name}: ${result.text}`).toBe(false);
  if (!contract.structured) {
    expect(result.structuredContent, name).toBeUndefined();
    return;
  }
  expect(result.structuredContent, name).toBeDefined();
  // The compatibility text block is byte-identical to the structured value.
  expect(result.text, name).toBe(JSON.stringify(result.structuredContent));
  expect(result.structuredContent, name).toEqual(result.data);
  expect(contract.outputSchema!.safeParse(result.structuredContent).success, name).toBe(true);
}

function expectResponse(name: string, value: unknown) {
  const schema = toolContract(name).responseSchema;
  if (!schema) return;
  const parsed = schema.safeParse(value);
  expect(parsed.success, `${name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 800)}`).toBe(true);
}

describe("tool outputs through the SDK client", () => {
  it("every driven tool returns its exact contract; structured tools mirror the text block", async () => {
    const f = await contractFixture();
    try {
      const structuredSeen = new Set<string>();
      for (const [scenarios, call] of [[readScenarios, f.read], [writeScenarios, f.write]] as const) {
        for (const scenario of scenarios) {
          // callTool itself AJV-validates structuredContent against the advertised outputSchema.
          const result = await call(scenario.tool, scenario.args(f.seed, f));
          expectStructured(scenario.tool, result);
          expectResponse(scenario.tool, result.data);
          if (result.structuredContent) structuredSeen.add(scenario.tool);
        }
      }
      const structured = toolContractNames().filter((name) => toolContract(name).structured);
      expect([...structuredSeen].sort()).toEqual(structured);
    } finally { await f.close(); }
  });

  it("validates each response mode against its exact schema", async () => {
    const f = await contractFixture();
    try {
      // Issue mutations: full and compact.
      const full = await f.write("update_issue", { identifier: "ENG-2", priority: 2 });
      const compact = await f.write("update_issue", { identifier: "ENG-2", priority: 1, response: "compact" });
      expect(issueMutationFullSchema.safeParse(full.structuredContent).success).toBe(true);
      expect(issueMutationReceiptSchema.safeParse(full.structuredContent).success).toBe(false);
      expect(issueMutationReceiptSchema.safeParse(compact.structuredContent).success).toBe(true);
      expect(issueMutationFullSchema.safeParse(compact.structuredContent).success).toBe(false);
      expect(compact.structuredContent).toMatchObject({ identifier: "ENG-2", changed: true, changedFields: ["priority"], alreadyExisted: null });
      const replayed = await f.write("create_issue", { title: "Fictional retro", idempotencyKey: "fictional-retro" });
      const replay = await f.write("create_issue", { title: "Fictional retro", idempotencyKey: "fictional-retro" });
      expect(issueMutationFullSchema.parse(replay.structuredContent).alreadyExisted).toBe(true);
      expect(replay.structuredContent).toMatchObject({ identifier: (replayed.data as { identifier: string }).identifier });

      // Runs: full and summary views, text-only (unbounded collections) but exact.
      const runFull = await f.read("get_run", { run: f.seed.run });
      const runSummary = await f.read("get_run", { run: f.seed.run, view: "summary" });
      expect(runFull.structuredContent).toBeUndefined();
      expect(runFullSchema.safeParse(runFull.data).success).toBe(true);
      expect(runSummarySchema.safeParse(runSummary.data).success).toBe(true);
      expect(runSummarySchema.safeParse(runFull.data).success).toBe(false);
      const stopped = await f.write("stop_run", { run: f.seed.run });
      expect(stopped.structuredContent).toBeUndefined();
      expect(runFullSchema.safeParse(stopped.data).success).toBe(true);

      // list_activity: paged envelope by default, the legacy bare array with full:true.
      const paged = await f.read("list_activity", { issue: "ENG-1" });
      const legacy = await f.read("list_activity", { issue: "ENG-1", full: true });
      expect(activityPageSchema.safeParse(paged.data).success).toBe(true);
      expect(activityArraySchema.safeParse(legacy.data).success).toBe(true);
      expect(Array.isArray(legacy.data)).toBe(true);

      // Page envelopes keep their own field names and cursor types. Run record, event and artifact
      // pages carry arbitrary engine payloads, so they are exact but text-only.
      const events = await f.read("list_run_events", { run: f.seed.run });
      const records = await f.read("list_run_records", { run: f.seed.run, collection: "participants", limit: 1 });
      const artifacts = await f.read("list_run_artifacts", { run: f.seed.run });
      for (const page of [events, records, artifacts]) expect(page.structuredContent).toBeUndefined();
      expect(runEventsPageSchema.parse(events.data).nextCursor).toEqual(expect.any(Number));
      expect(runRecordsPageSchema.parse(records.data)).toMatchObject({ run: f.seed.run, collection: "participants" });
      expect(runRecordsPageSchema.parse(artifacts.data).collection).toBe("artifacts");
      const runs = await f.read("list_runs", { limit: 1 });
      expect(runSummaryPageSchema.parse(runs.structuredContent).nextCursor).toEqual(expect.any(String));
      const projected = await f.read("list_issues", { fields: ["labels", "stateName"], limit: 1 });
      expect(issueSummaryPageSchema.parse(projected.structuredContent).issues[0]).toHaveProperty("stateName");
      const searched = await f.read("search", { query: "fictional" });
      expect(issueSummaryPageSchema.parse(searched.structuredContent).issues.every((issue) => typeof issue.snippet === "string")).toBe(true);
    } finally { await f.close(); }
  });

  it("returns text-only error envelopes (never structuredContent) from structured tools", async () => {
    const f = await contractFixture();
    try {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["get_project", { project: "No Such Project" }, "PROJECT_NOT_FOUND"],
        ["list_runs", { issue: "ENG-404" }, "ISSUE_NOT_FOUND"],
        ["list_issues", { limit: "many" }, "VALIDATION_FAILED"],
        ["update_issue", { identifier: "ENG-404", priority: 1 }, "ISSUE_NOT_FOUND"],
        ["create_team", { key: "ENG", name: "Duplicate" }, "TEAM_KEY_TAKEN"],
        ["update_issue", { identifier: "ENG-1", priority: 1, expectedRevision: 999 }, "ISSUE_CONFLICT"]
      ];
      for (const [tool, args, code] of cases) {
        expect(toolContract(tool).structured, tool).toBe(true);
        const result = await f.write(tool, args);
        expect(result.isError, tool).toBe(true);
        expect(result.structuredContent, tool).toBeUndefined();
        expect(errorEnvelopeSchema.parse(result.data).error.code, tool).toBe(code);
      }
      await f.write("archive_project", { project: "Fictional Archive" });
      const conflict = await f.write("archive_project", { project: "Fictional Archive" });
      expect(conflict.structuredContent).toBeUndefined();
      expect(errorEnvelopeSchema.safeParse(conflict.data).success).toBe(true);
    } finally { await f.close(); }
  });

  it("start_run returns the exact full run, text-only", async () => {
    const f = await contractFixture();
    try {
      // A healthy probe of the fictional engine, as tracker-agentd would record it.
      const { engines } = engineCatalogSchema.parse(JSON.parse(readFileSync(f.engineConfig, "utf8")));
      for (const [engineName, engine] of Object.entries(engines)) {
        recordEngineHealth(f.context, {
          engineName, fingerprint: engineHealthFingerprint(engineName, engine), installed: true, authenticated: true, modelAccessible: true,
          diagnosticCode: null, remediation: null, checkedAt: "2026-02-01T00:00:00.000Z"
        });
      }
      const preview = await f.write("preview_run", { issue: "ENG-2" });
      expect(preview.isError, preview.text).toBe(false);
      const { previewFingerprint, warnings } = preview.data as { previewFingerprint: string; warnings: string[] };
      const started = await f.write("start_run", { issue: "ENG-2", previewFingerprint, confirmWarnings: warnings });
      expectStructured("start_run", started);
      expectResponse("start_run", started.data);
      expect(runFullSchema.parse(started.data)).toMatchObject({ issueId: expect.any(String) });
    } finally { await f.close(); }
  });

  it("reports a result that breaks its advertised schema as TOOL_CONTRACT_VIOLATION, not a database failure", async () => {
    // Checked in the handler: names the tool and says whether a write may have committed.
    expect(() => toolResult("create_team", { key: "QA" })).toThrow(
      expect.objectContaining({ code: "TOOL_CONTRACT_VIOLATION", details: expect.objectContaining({ tool: "create_team", mayHaveBeenApplied: true }) })
    );
    expect(() => toolResult("get_project", { name: "Fictional" })).toThrow(
      expect.objectContaining({ code: "TOOL_CONTRACT_VIOLATION", details: expect.objectContaining({ mayHaveBeenApplied: false }) })
    );
    const inHandler = mcpToolResult(() => toolResult("create_team", { key: "QA" }));
    expect(errorEnvelopeSchema.parse(JSON.parse(inHandler.content[0]!.text)).error.code).toBe("TOOL_CONTRACT_VIOLATION");
    // The SDK's own post-handler check arrives as a message string; it is classified the same way.
    const sdk = jsonErrorResult("MCP error -32602: Output validation error: Invalid structured content for tool create_team: missing id");
    const envelope = errorEnvelopeSchema.parse(JSON.parse(sdk.content[0].text));
    expect(envelope.error).toMatchObject({ code: "TOOL_CONTRACT_VIOLATION", details: { mayHaveBeenApplied: true } });
    expect(sdk.isError).toBe(true);
  });

  it("validates CLI --json output against the same core schemas (color-independent)", async () => {
    const f = await contractFixture();
    try {
      const cli = (args: string[]) => JSON.parse(f.cli([...args, "--json"]));
      const parity: Array<[string, Record<string, unknown>, string[]]> = [
        ["list_issues", {}, ["issue", "list"]],
        ["get_project", { project: "Fictional Delivery" }, ["project", "view", "Fictional Delivery"]],
        ["get_repository", { repository: "Primary" }, ["repo", "view", "Primary"]],
        ["get_orchestration_profile", { profile: "Fictional Review" }, ["profile", "view", "Fictional Review"]],
        ["list_runs", {}, ["run", "list"]],
        ["get_run", { run: f.seed.run, view: "summary" }, ["run", "view", f.seed.run, "--view", "summary"]],
        ["list_run_records", { run: f.seed.run, collection: "participants" }, ["run", "records", f.seed.run, "participants"]],
        ["list_run_events", { run: f.seed.run }, ["run", "events", f.seed.run]],
        ["list_run_artifacts", { run: f.seed.run }, ["run", "artifacts", f.seed.run]],
        ["list_activity", { issue: "ENG-1" }, ["issue", "history", "ENG-1"]],
        ["list_labels", {}, ["label", "list"]],
        ["list_teams", {}, ["team", "list"]]
      ];
      for (const [tool, args, command] of parity) {
        const mcp = await f.read(tool, args);
        const output = cli(command);
        expectResponse(tool, output);
        expect(output, command.join(" ")).toEqual(mcp.data);
      }
      expectResponse("search", cli(["issue", "search", "fictional"]));
      expectResponse("update_issue", cli(["issue", "update", "ENG-2", "--priority", "2", "--response", "compact"]));
      expect(issueMutationReceiptSchema.safeParse(cli(["issue", "update", "ENG-2", "--priority", "3", "--response", "compact"])).success).toBe(true);
      expect(exactOutputSchemas.actor.safeParse(cli(["whoami"])).success).toBe(true);
      const error = f.cliError(["project", "view", "No Such Project", "--json"]);
      expect(errorEnvelopeSchema.parse(error).error.code).toBe("PROJECT_NOT_FOUND");
    } finally { await f.close(); }
  }, 60_000);
});
