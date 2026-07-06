import {
  listLabels,
  listLabelsInputSchema,
  serializeLabel
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerLabelTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_labels",
    {
      title: "List labels",
      description: "List labels.",
      inputSchema: listLabelsInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listLabelsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listLabels(context, parsed).map(serializeLabel))
      );
    })
  );
}
