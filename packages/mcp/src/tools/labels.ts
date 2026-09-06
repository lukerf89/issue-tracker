import {
  archiveLabel,
  archiveLabelInputSchema,
  createLabel,
  createLabelInputSchema,
  listLabels,
  listLabelsInputSchema,
  serializeLabel,
  unarchiveLabel,
  unarchiveLabelInputSchema
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerLabelTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "create_label",
    {
      _meta: { "issue-tracker/groups": ["admin"] },
      title: "Create label",
      description: "Create a label.",
      inputSchema: createLabelInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createLabelInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeLabel(createLabel(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_labels",
    {
      _meta: { "issue-tracker/groups": ["admin"] },
      title: "List labels",
      description: "List labels.",
      inputSchema: listLabelsInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = listLabelsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listLabels(context, parsed).map(serializeLabel))
      );
    })
  );

  server.registerTool(
    "archive_label",
    {
      _meta: { "issue-tracker/groups": ["admin"] },
      title: "Archive label",
      description: "Archive a label without deleting it.",
      inputSchema: archiveLabelInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = archiveLabelInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeLabel(archiveLabel(context, parsed.label)))
      );
    })
  );

  server.registerTool(
    "unarchive_label",
    {
      _meta: { "issue-tracker/groups": ["admin"] },
      title: "Unarchive label",
      description: "Restore an archived label.",
      inputSchema: unarchiveLabelInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = unarchiveLabelInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeLabel(unarchiveLabel(context, parsed.label)))
      );
    })
  );
}
