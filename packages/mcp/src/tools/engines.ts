import { z } from "zod";

import { createNodeEngineCatalogRuntime, getEngine, loadEngineCatalog, resolveEngineCatalogPath, validateEngineCatalog, toolGroups } from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { mcpToolResult, toolConfig, toolResult } from "./result.js";

const configInput = z.object({ config: z.string().min(1).optional() }).strict();
const engineInput = configInput.extend({ engine: z.string().min(1) }).strict();

export function registerEngineTools(server: McpServer) {
  server.registerTool("list_engines", {
      _meta: toolGroups("orchestration"), ...toolConfig("list_engines"), description: "List and validate local engine definitions without revealing environment values.", inputSchema: configInput.strict() }, (input) => mcpToolResult(() => { const parsed = configInput.parse(input); const runtime = createNodeEngineCatalogRuntime(); return toolResult("list_engines", validateEngineCatalog(loadEngineCatalog(parsed.config ?? resolveEngineCatalogPath(), runtime), runtime)); }));
  server.registerTool("get_engine", {
      _meta: toolGroups("orchestration"), ...toolConfig("get_engine"), description: "Read a redacted local engine definition.", inputSchema: engineInput.strict() }, (input) => mcpToolResult(() => { const parsed = engineInput.parse(input); const runtime = createNodeEngineCatalogRuntime(); const engine = getEngine(loadEngineCatalog(parsed.config ?? resolveEngineCatalogPath(), runtime), parsed.engine); return toolResult("get_engine", { name: parsed.engine, ...engine, envNames: engine.envNames.map((name) => `${name}=<inherited>`) }); }));
  server.registerTool("validate_engines", {
      _meta: toolGroups("orchestration"), ...toolConfig("validate_engines"), description: "Validate local engine configuration and executable availability.", inputSchema: configInput.strict() }, (input) => mcpToolResult(() => { const parsed = configInput.parse(input); const runtime = createNodeEngineCatalogRuntime(); return toolResult("validate_engines", validateEngineCatalog(loadEngineCatalog(parsed.config ?? resolveEngineCatalogPath(), runtime), runtime)); }));
}
