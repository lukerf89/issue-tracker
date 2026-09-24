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
  serializeTemplate,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { mcpToolResult, toolConfig, toolResult, withMcpContext } from "./result.js";

export function registerTemplateTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "create_template",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("create_template"),
      description: "Create a named issue creation template.",
      inputSchema: createTemplateInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createTemplateInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "create_template" }, ({ context }) =>
        toolResult("create_template", serializeTemplate(createTemplate(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_templates",
    {
      _meta: toolGroups("coding"),
      ...toolConfig("list_templates"),
      description: "List named issue creation templates.",
      inputSchema: listTemplatesInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      listTemplatesInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "list_templates" }, ({ context }) =>
        toolResult("list_templates", listTemplates(context).map(serializeTemplate))
      );
    })
  );

  server.registerTool(
    "delete_template",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("delete_template"),
      description: "Delete a named issue creation template.",
      inputSchema: deleteTemplateInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = deleteTemplateInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "delete_template" }, ({ context }) =>
        toolResult("delete_template", serializeTemplate(deleteTemplate(context, parsed.name)))
      );
    })
  );

  server.registerTool(
    "create_issue_from_template",
    {
      _meta: toolGroups("coding"),
      ...toolConfig("create_issue_from_template"),
      description: "Create an issue from a named template with optional overrides.",
      inputSchema: createIssueFromTemplateInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createIssueFromTemplateInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "create_issue_from_template" }, ({ context }) => {
        const created = createIssueFromTemplate(
          context,
          parsed.name,
          parsed.overrides
        );
        return toolResult("create_issue_from_template", { ...serializeIssue(created), alreadyExisted: created.alreadyExisted });
      });
    })
  );
}
