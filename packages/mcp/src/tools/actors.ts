import {
  listActors,
  listActorsInputSchema,
  serializeActor
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerActorTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_actors",
    {
      title: "List actors",
      description: "List actors.",
      inputSchema: listActorsInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listActorsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listActors(context, parsed).map(serializeActor))
      );
    })
  );
}
