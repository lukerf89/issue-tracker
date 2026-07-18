import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

import {
  archiveRun, createNodeEngineCatalogRuntime, createNodeRepositoryInspector, getRun, getRunMetrics, listRunEvents, listRunEventsInputSchema, listRuns, loadEngineCatalog,
  listRunsInputSchema, nudgeRun, previewRun, previewRunInputSchema, requestRunStop, resolvePermissionInputSchema,
  resolveRunPermission, respondRunInputSchema, respondToRunInput, retryRun, retryRunInputSchema,
  requestRunCleanup, requestRunPublication, resolveEngineCatalogPath, resumeRun, runRefSchema, startRun, startRunInputSchema
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerRunTools(server: McpServer, options: Omit<OpenMcpContextOptions, "requireActor">) {
  server.registerTool("preview_run", { title: "Preview run", description: "Resolve an autonomous coding run without mutation.", inputSchema: previewRunInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(previewRun(context, previewRunInputSchema.parse(input), runRuntime())))));
  server.registerTool("start_run", { title: "Start run", description: "Persist a previously previewed autonomous coding run.", inputSchema: startRunInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(startRun(context, startRunInputSchema.parse(input), runRuntime())))));
  server.registerTool("list_runs", { title: "List runs", description: "List autonomous coding runs.", inputSchema: listRunsInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listRuns(context, listRunsInputSchema.parse(input))))));
  server.registerTool("get_run", { title: "Get run", description: "Read an autonomous coding run.", inputSchema: runRefSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getRun(context, runRefSchema.parse(input).run)))));
  server.registerTool("list_run_events", { title: "List run events", description: "Read normalized run events after a cursor.", inputSchema: listRunEventsInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listRunEvents(context, listRunEventsInputSchema.parse(input))))));
  server.registerTool("respond_to_run", { title: "Respond to run", description: "Answer an exact pending participant request.", inputSchema: respondRunInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(respondToRunInput(context, respondRunInputSchema.parse(input))))));
  server.registerTool("resolve_run_permission", { title: "Resolve permission", description: "Approve or deny an exact run permission request.", inputSchema: resolvePermissionInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(resolveRunPermission(context, resolvePermissionInputSchema.parse(input))))));
  const stopSchema = runRefSchema.extend({ force: z.boolean().default(false) }).strict();
  server.registerTool("stop_run", { title: "Stop run", description: "Request graceful or forced stop of an active run.", inputSchema: stopSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = stopSchema.parse(input); return jsonResult(requestRunStop(context, parsed.run, parsed.force)); })));
  server.registerTool("retry_run", { title: "Retry run", description: "Create a new attempt for blocked or stalled work.", inputSchema: retryRunInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(retryRun(context, retryRunInputSchema.parse(input))))));
  server.registerTool("resume_run", { title: "Resume run", description: "Resume an exact provider session when the adapter supports it.", inputSchema: runRefSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(resumeRun(context, runRefSchema.parse(input).run)))));
  const nudgeSchema = runRefSchema.extend({ message: z.string().min(1) }).strict();
  server.registerTool("nudge_run", { title: "Nudge run", description: "Redirect an exact live participant session when the adapter supports it.", inputSchema: nudgeSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = nudgeSchema.parse(input); return jsonResult(nudgeRun(context, parsed.run, parsed.message)); })));
  server.registerTool("list_run_artifacts", { title: "List run artifacts", description: "List structured artifact metadata.", inputSchema: runRefSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getRun(context, runRefSchema.parse(input).run).artifacts))));
  server.registerTool("archive_run", { title: "Archive run", description: "Archive terminal structured run history.", inputSchema: runRefSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(archiveRun(context, runRefSchema.parse(input).run)))));
  const publishSchema = z.object({ run: z.string().uuid(), publishDraftPr: z.boolean().default(true), confirmed: z.literal(true) }).strict();
  server.registerTool("publish_run", { title: "Publish run", description: "Explicitly authorize push and optional draft pull-request publication.", inputSchema: publishSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(requestRunPublication(context, publishSchema.parse(input))))));
  const cleanupSchema = z.object({ run: z.string().uuid(), kind: z.enum(["worktree", "raw_logs"]), confirmed: z.literal(true), allowUnmerged: z.boolean().optional() }).strict();
  server.registerTool("cleanup_run", { title: "Clean up run", description: "Queue an explicitly confirmed, containment-checked cleanup action.", inputSchema: cleanupSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = cleanupSchema.parse(input); return jsonResult(requestRunCleanup(context, { ...parsed, managedRoot: resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "issue-tracker", parsed.kind === "worktree" ? "worktrees" : "runs") })); })));
  server.registerTool("get_run_metrics", { title: "Get run metrics", description: "Read local operational metrics from structured state.", inputSchema: z.object({}).strict().shape }, () => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getRunMetrics(context)))));
}

function runRuntime() {
  const engineRuntime = createNodeEngineCatalogRuntime();
  return { inspector: createNodeRepositoryInspector(), dataRoot: resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "issue-tracker"), engineCatalog: loadEngineCatalog(resolveEngineCatalogPath(), engineRuntime), executableAvailable: engineRuntime.executableAvailable, requireEngineHealth: true };
}
