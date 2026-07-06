import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerIssueResources } from "./resources/issues.js";
import { registerActorTools } from "./tools/actors.js";
import { registerCycleTools } from "./tools/cycles.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerLabelTools } from "./tools/labels.js";
import { registerProjectTools } from "./tools/projects.js";
import { jsonErrorResult } from "./tools/result.js";
import { registerTeamTools } from "./tools/teams.js";
import type { McpActorContext } from "./context.js";

export interface CreateServerOptions {
  dbPath: string;
  actor?: McpActorContext;
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer({
    name: "issue-tracker",
    version: "0.0.0"
  });

  (server as unknown as { createToolError: typeof jsonErrorResult }).createToolError =
    jsonErrorResult;

  registerActorTools(server, options);
  registerIssueTools(server, options);
  registerCycleTools(server, options);
  registerLabelTools(server, options);
  registerProjectTools(server, options);
  registerTeamTools(server, options);
  registerIssueResources(server, options);

  return server;
}

export async function runStdioServer(options: CreateServerOptions): Promise<void> {
  const server = createServer(options);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

export type { McpActorContext } from "./context.js";
