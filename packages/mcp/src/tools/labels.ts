import {
  archiveLabel,
  archiveLabelInputSchema,
  createLabel,
  createLabelInputSchema,
  listLabels,
  listLabelsInputSchema,
  serializeLabel,
  unarchiveLabel,
  unarchiveLabelInputSchema,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { mcpToolResult, toolConfig, toolResult, withMcpContext } from "./result.js";

export function registerLabelTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "create_label",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("create_label"),
      description: "Create a label.",
      inputSchema: createLabelInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createLabelInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "create_label" }, ({ context }) =>
        toolResult("create_label", serializeLabel(createLabel(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_labels",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("list_labels"),
      description: "List labels.",
      inputSchema: listLabelsInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = listLabelsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "list_labels" }, ({ context }) =>
        toolResult("list_labels", listLabels(context, parsed).map(serializeLabel))
      );
    })
  );

  server.registerTool(
    "archive_label",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("archive_label"),
      description: "Archive a label without deleting it.",
      inputSchema: archiveLabelInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = archiveLabelInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "archive_label" }, ({ context }) =>
        toolResult("archive_label", serializeLabel(archiveLabel(context, parsed.label)))
      );
    })
  );

  server.registerTool(
    "unarchive_label",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("unarchive_label"),
      description: "Restore an archived label.",
      inputSchema: unarchiveLabelInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = unarchiveLabelInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "unarchive_label" }, ({ context }) =>
        toolResult("unarchive_label", serializeLabel(unarchiveLabel(context, parsed.label)))
      );
    })
  );
}
