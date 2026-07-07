import {
  createSavedView,
  createSavedViewInputSchema,
  deleteSavedView,
  deleteSavedViewInputSchema,
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
    "create_saved_view",
    {
      title: "Create saved view",
      description: "Save a named issue filter preset.",
      inputSchema: createSavedViewInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = createSavedViewInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeSavedView(createSavedView(context, parsed)))
      );
    })
  );

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

  server.registerTool(
    "delete_saved_view",
    {
      title: "Delete saved view",
      description: "Delete a named issue filter preset.",
      inputSchema: deleteSavedViewInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = deleteSavedViewInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeSavedView(deleteSavedView(context, parsed.idOrName)))
      );
    })
  );
}
