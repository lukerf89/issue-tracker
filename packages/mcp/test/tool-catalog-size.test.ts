import { writeFileSync } from "node:fs";

import { toolContract, toolProfileSchema } from "@issue-tracker/core";
import { expect, it } from "vitest";

import { agentFixture } from "./agent-fixture.js";
import { contractFixture } from "./contract-fixture.js";

/** Budgeted or unbounded outputs: never duplicated into structuredContent. */
const TEXT_ONLY = ["get_issue", "get_issues", "read_issue_section", "get_work_context", "get_run", "list_activity", "list_activity_feed", "describe", "preview_run", "start_run", "stop_run", "retry_run", "resume_run", "nudge_run", "archive_run"];

const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));

it("measures catalog and response sizes without duplicating budgeted outputs", async () => {
  const report: Record<string, unknown> = {};

  const catalog: Record<string, { tools: number; bytes: number; withoutContractsBytes: number; outputSchemaBytes: number; annotationBytes: number }> = {};
  for (const profile of toolProfileSchema.options) {
    const f = await agentFixture({ toolProfile: profile });
    try {
      const { tools } = await f.client.listTools();
      catalog[profile] = {
        tools: tools.length,
        bytes: bytes({ tools }),
        // The same catalog without annotations and outputSchema (the pre-contract shape).
        withoutContractsBytes: bytes({ tools: tools.map((tool) => ({ ...tool, annotations: undefined, outputSchema: undefined })) }),
        outputSchemaBytes: tools.reduce((sum, tool) => sum + (tool.outputSchema ? bytes(tool.outputSchema) : 0), 0),
        annotationBytes: tools.reduce((sum, tool) => sum + bytes(tool.annotations ?? {}), 0)
      };
      for (const tool of tools) {
        if (TEXT_ONLY.includes(tool.name)) expect(tool.outputSchema, tool.name).toBeUndefined();
      }
    } finally { await f.close(); }
  }
  report.catalog = catalog;
  // Loose ceiling only: the full catalog stays well under 256 KiB.
  expect(catalog.full!.bytes).toBeLessThan(256 * 1024);

  const f = await contractFixture();
  try {
    const responses: Record<string, { textBytes: number; structuredBytes: number }> = {};
    const measure = async (label: string, name: string, args: Record<string, unknown>, write = false) => {
      const result = await (write ? f.write : f.read)(name, args);
      expect(result.isError, `${name}: ${result.text}`).toBe(false);
      if (TEXT_ONLY.includes(name)) expect(result.structuredContent, name).toBeUndefined();
      expect(result.structuredContent !== undefined, name).toBe(toolContract(name).structured);
      responses[label] = { textBytes: bytes(result.text), structuredBytes: result.structuredContent ? bytes(result.structuredContent) : 0 };
    };
    await measure("list_issues", "list_issues", {});
    await measure("search", "search", { query: "fictional" });
    await measure("list_runs", "list_runs", {});
    await measure("list_run_events", "list_run_events", { run: f.seed.run });
    await measure("update_issue compact", "update_issue", { identifier: "ENG-2", priority: 2, response: "compact" }, true);
    await measure("update_issue full", "update_issue", { identifier: "ENG-2", priority: 3 }, true);
    await measure("get_issue", "get_issue", { identifier: "ENG-1" });
    await measure("get_issues", "get_issues", { identifiers: ["ENG-1", "ENG-2"] });
    await measure("get_work_context", "get_work_context", { identifier: "ENG-1" });
    await measure("get_run full", "get_run", { run: f.seed.run });
    await measure("list_activity_feed", "list_activity_feed", {});
    await measure("describe", "describe", {}, true);
    report.responses = responses;
  } finally { await f.close(); }

  // Opt-in report for the PR body: TOOL_SIZE_REPORT=/path npm test.
  if (process.env.TOOL_SIZE_REPORT) writeFileSync(process.env.TOOL_SIZE_REPORT, JSON.stringify(report, null, 2));
});
