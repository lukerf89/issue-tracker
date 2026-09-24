import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

import {
  archiveRun, createNodeEngineCatalogRuntime, createNodeRepositoryInspector, getRun, getRunInputSchema, getRunMetrics, getRunSummary, listRunArtifactsInputSchema, listRunEvents, listRunEventsInputSchema,
  listRunRecords, listRunRecordsInputSchema, listRunSummaries, loadEngineCatalog, runMutationViewSchema, runResponse,
  listRunsInputSchema, nudgeRun, previewRun, previewRunInputSchema, requestRunStop, resolvePermissionInputSchema,
  resolveRunPermission, respondRunInputSchema, respondToRunInput, retryRun, retryRunInputSchema,
  requestRunCleanup, requestRunPublication, resolveEngineCatalogPath, resumeRun, startRun, startRunInputSchema,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerRunTools(server: McpServer, options: Omit<OpenMcpContextOptions, "requireActor">) {
  server.registerTool("preview_run", {
      _meta: toolGroups("orchestration"), title: "Preview run", description: "Resolve an autonomous coding run without mutation.", inputSchema: previewRunInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(previewRun(context, previewRunInputSchema.parse(input), runRuntime())))));
  server.registerTool("start_run", {
      _meta: toolGroups("orchestration"), title: "Start run", description: "Persist a previously previewed autonomous coding run.", inputSchema: startRunInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(startRun(context, startRunInputSchema.parse(input), runRuntime())))));
  server.registerTool("list_runs", {
      _meta: toolGroups("orchestration"), title: "List runs", description: "List bounded pages of compact run summaries (newest first). Follow nextCursor with the same filters; read configuration and related collections with get_run or list_run_records.", inputSchema: listRunsInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listRunSummaries(context, listRunsInputSchema.parse(input))))));
  server.registerTool("get_run", {
      _meta: toolGroups("orchestration"), title: "Get run", description: "Read an autonomous coding run. view=full (default) includes configuration and every related collection; view=summary returns the compact status used for polling.", inputSchema: getRunInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => { const parsed = getRunInputSchema.parse(input); return jsonResult(parsed.view === "summary" ? getRunSummary(context, parsed.run) : getRun(context, parsed.run)); })));
  server.registerTool("list_run_records", {
      _meta: toolGroups("orchestration"), title: "List run records", description: "Page through one related collection of a run (repositories, attempts, participants, artifacts, inputRequests, verifications, reviewFindings, pendingActions).", inputSchema: listRunRecordsInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listRunRecords(context, listRunRecordsInputSchema.parse(input))))));
  server.registerTool("list_run_events", {
      _meta: toolGroups("orchestration"), title: "List run events", description: "Read normalized run events after a cursor.", inputSchema: listRunEventsInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listRunEvents(context, listRunEventsInputSchema.parse(input))))));
  server.registerTool("respond_to_run", {
      _meta: toolGroups("orchestration"), title: "Respond to run", description: "Answer an exact pending participant request.", inputSchema: respondRunInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(respondToRunInput(context, respondRunInputSchema.parse(input))))));
  server.registerTool("resolve_run_permission", {
      _meta: toolGroups("orchestration"), title: "Resolve permission", description: "Approve or deny an exact run permission request.", inputSchema: resolvePermissionInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(resolveRunPermission(context, resolvePermissionInputSchema.parse(input))))));
  const stopSchema = runMutationViewSchema.extend({ force: z.boolean().default(false) }).strict();
  server.registerTool("stop_run", {
      _meta: toolGroups("orchestration"), title: "Stop run", description: "Request graceful or forced stop of an active run.", inputSchema: stopSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = stopSchema.parse(input); return jsonResult(runResponse(context, requestRunStop(context, parsed.run, parsed.force), parsed.view)); })));
  server.registerTool("retry_run", {
      _meta: toolGroups("orchestration"), title: "Retry run", description: "Create a new attempt for blocked or stalled work.", inputSchema: retryRunInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = retryRunInputSchema.parse(input); return jsonResult(runResponse(context, retryRun(context, parsed), parsed.view)); })));
  server.registerTool("resume_run", {
      _meta: toolGroups("orchestration"), title: "Resume run", description: "Resume an exact provider session when the adapter supports it.", inputSchema: runMutationViewSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = runMutationViewSchema.parse(input); return jsonResult(runResponse(context, resumeRun(context, parsed.run), parsed.view)); })));
  const nudgeSchema = runMutationViewSchema.extend({ message: z.string().min(1) }).strict();
  server.registerTool("nudge_run", {
      _meta: toolGroups("orchestration"), title: "Nudge run", description: "Redirect an exact live participant session when the adapter supports it.", inputSchema: nudgeSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = nudgeSchema.parse(input); return jsonResult(runResponse(context, nudgeRun(context, parsed.run, parsed.message), parsed.view)); })));
  server.registerTool("list_run_artifacts", {
      _meta: toolGroups("orchestration"), title: "List run artifacts", description: "Page through structured artifact metadata (same envelope as list_run_records with collection=artifacts).", inputSchema: listRunArtifactsInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listRunRecords(context, { ...listRunArtifactsInputSchema.parse(input), collection: "artifacts" })))));
  server.registerTool("archive_run", {
      _meta: toolGroups("orchestration"), title: "Archive run", description: "Archive terminal structured run history.", inputSchema: runMutationViewSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = runMutationViewSchema.parse(input); return jsonResult(runResponse(context, archiveRun(context, parsed.run), parsed.view)); })));
  const publishSchema = z.object({ run: z.string().uuid(), publishDraftPr: z.boolean().default(true), confirmed: z.literal(true) }).strict();
  server.registerTool("publish_run", {
      _meta: toolGroups("orchestration"), title: "Publish run", description: "Explicitly authorize push and optional draft pull-request publication.", inputSchema: publishSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(requestRunPublication(context, publishSchema.parse(input))))));
  const cleanupSchema = z.object({ run: z.string().uuid(), kind: z.enum(["worktree", "raw_logs"]), confirmed: z.literal(true), allowUnmerged: z.boolean().optional() }).strict();
  server.registerTool("cleanup_run", {
      _meta: toolGroups("orchestration"), title: "Clean up run", description: "Queue an explicitly confirmed, containment-checked cleanup action.", inputSchema: cleanupSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => { const parsed = cleanupSchema.parse(input); return jsonResult(requestRunCleanup(context, { ...parsed, managedRoot: resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "issue-tracker", parsed.kind === "worktree" ? "worktrees" : "runs") })); })));
  server.registerTool("get_run_metrics", {
      _meta: toolGroups("orchestration"), title: "Get run metrics", description: "Read local operational metrics from structured state.", inputSchema: z.strictObject({}) }, () => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getRunMetrics(context)))));
}

function runRuntime() {
  const engineRuntime = createNodeEngineCatalogRuntime();
  return { inspector: createNodeRepositoryInspector(), dataRoot: resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "issue-tracker"), engineCatalog: loadEngineCatalog(resolveEngineCatalogPath(), engineRuntime), executableAvailable: engineRuntime.executableAvailable, requireEngineHealth: true };
}
