import {
  createSavedView,
  builtinIssueViews,
  createSavedViewInputSchema,
  deleteSavedView,
  deleteSavedViewInputSchema,
  listSavedViews,
  listSavedViewsInputSchema,
  serializeSavedView,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { mcpToolResult, toolConfig, toolResult, withMcpContext } from "./result.js";

export function registerSavedViewTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool("list_builtin_views", {
    _meta: toolGroups("coding"),
    ...toolConfig("list_builtin_views"),
    description: "Built-in view references, query semantics and filter definitions; use a reference with list_issues.",
    inputSchema: listSavedViewsInputSchema.strict()
  }, () => mcpToolResult(() => toolResult("list_builtin_views", builtinIssueViews)));

  server.registerTool(
    "create_saved_view",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("create_saved_view"),
      description: "Save a named issue filter preset.",
      inputSchema: createSavedViewInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createSavedViewInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "create_saved_view" }, ({ context }) =>
        toolResult("create_saved_view", serializeSavedView(createSavedView(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_saved_views",
    {
      _meta: toolGroups("coding"),
      ...toolConfig("list_saved_views"),
      description: "List named issue filter presets.",
      inputSchema: listSavedViewsInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      listSavedViewsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "list_saved_views" }, ({ context }) =>
        toolResult("list_saved_views", listSavedViews(context).map(serializeSavedView))
      );
    })
  );

  server.registerTool(
    "delete_saved_view",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("delete_saved_view"),
      description: "Delete a named issue filter preset.",
      inputSchema: deleteSavedViewInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = deleteSavedViewInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "delete_saved_view" }, ({ context }) =>
        toolResult("delete_saved_view", serializeSavedView(deleteSavedView(context, parsed.idOrName)))
      );
    })
  );
}
