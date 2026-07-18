import { z } from "zod";

import { createNodeEngineCatalogRuntime, getEngine, loadEngineCatalog, resolveEngineCatalogPath, validateEngineCatalog } from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsonResult, mcpToolResult } from "./result.js";

const configInput = z.object({ config: z.string().min(1).optional() }).strict();
const engineInput = configInput.extend({ engine: z.string().min(1) }).strict();

export function registerEngineTools(server: McpServer) {
  server.registerTool("list_engines", { title: "List engines", description: "List and validate local engine definitions without revealing environment values.", inputSchema: configInput.shape }, (input) => mcpToolResult(() => { const parsed = configInput.parse(input); const runtime = createNodeEngineCatalogRuntime(); return jsonResult(validateEngineCatalog(loadEngineCatalog(parsed.config ?? resolveEngineCatalogPath(), runtime), runtime)); }));
  server.registerTool("get_engine", { title: "Get engine", description: "Read a redacted local engine definition.", inputSchema: engineInput.shape }, (input) => mcpToolResult(() => { const parsed = engineInput.parse(input); const runtime = createNodeEngineCatalogRuntime(); const engine = getEngine(loadEngineCatalog(parsed.config ?? resolveEngineCatalogPath(), runtime), parsed.engine); return jsonResult({ name: parsed.engine, ...engine, envNames: engine.envNames.map((name) => `${name}=<inherited>`) }); }));
  server.registerTool("validate_engines", { title: "Validate engines", description: "Validate local engine configuration and executable availability.", inputSchema: configInput.shape }, (input) => mcpToolResult(() => { const parsed = configInput.parse(input); const runtime = createNodeEngineCatalogRuntime(); return jsonResult(validateEngineCatalog(loadEngineCatalog(parsed.config ?? resolveEngineCatalogPath(), runtime), runtime)); }));
}
