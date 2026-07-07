import {
  listTemplates,
  listTemplatesInputSchema,
  serializeTemplate
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerTemplateTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description: "List named issue creation templates.",
      inputSchema: listTemplatesInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      listTemplatesInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listTemplates(context).map(serializeTemplate))
      );
    })
  );
}
