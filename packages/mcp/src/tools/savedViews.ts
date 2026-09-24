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
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerSavedViewTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool("list_builtin_views", {
    _meta: toolGroups("coding"),
    title: "List built-in views",
    description: "Built-in view references, query semantics and filter definitions; use a reference with list_issues.",
    inputSchema: listSavedViewsInputSchema.strict()
  }, () => mcpToolResult(() => jsonResult(builtinIssueViews)));

  server.registerTool(
    "create_saved_view",
    {
      _meta: toolGroups("admin"),
      title: "Create saved view",
      description: "Save a named issue filter preset.",
      inputSchema: createSavedViewInputSchema.strict()
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
      _meta: toolGroups("coding"),
      title: "List saved views",
      description: "List named issue filter presets.",
      inputSchema: listSavedViewsInputSchema.strict()
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
      _meta: toolGroups("admin"),
      title: "Delete saved view",
      description: "Delete a named issue filter preset.",
      inputSchema: deleteSavedViewInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = deleteSavedViewInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeSavedView(deleteSavedView(context, parsed.idOrName)))
      );
    })
  );
}
