import {
  createIssueFromTemplate,
  createIssueFromTemplateInputSchema,
  createTemplate,
  createTemplateInputSchema,
  deleteTemplate,
  deleteTemplateInputSchema,
  listTemplates,
  listTemplatesInputSchema,
  serializeIssue,
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
    "create_template",
    {
      title: "Create template",
      description: "Create a named issue creation template.",
      inputSchema: createTemplateInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = createTemplateInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeTemplate(createTemplate(context, parsed)))
      );
    })
  );

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

  server.registerTool(
    "delete_template",
    {
      title: "Delete template",
      description: "Delete a named issue creation template.",
      inputSchema: deleteTemplateInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = deleteTemplateInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeTemplate(deleteTemplate(context, parsed.name)))
      );
    })
  );

  server.registerTool(
    "create_issue_from_template",
    {
      title: "Create issue from template",
      description: "Create an issue from a named template with optional overrides.",
      inputSchema: createIssueFromTemplateInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = createIssueFromTemplateInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssue(createIssueFromTemplate(
          context,
          parsed.name,
          parsed.overrides
        )))
      );
    })
  );
}
