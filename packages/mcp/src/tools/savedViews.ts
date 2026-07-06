import {
  listSavedViews,
  listSavedViewsInputSchema,
  serializeSavedView
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerSavedViewTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_saved_views",
    {
      title: "List saved views",
      description: "List named issue filter presets.",
      inputSchema: listSavedViewsInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      listSavedViewsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listSavedViews(context).map(serializeSavedView))
      );
    })
  );
}
