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
      _meta: { "issue-tracker/groups": ["admin"] },
      title: "Create template",
      description: "Create a named issue creation template.",
      inputSchema: createTemplateInputSchema.strict()
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
      _meta: { "issue-tracker/groups": ["coding"] },
      title: "List templates",
      description: "List named issue creation templates.",
      inputSchema: listTemplatesInputSchema.strict()
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
      _meta: { "issue-tracker/groups": ["admin"] },
      title: "Delete template",
      description: "Delete a named issue creation template.",
      inputSchema: deleteTemplateInputSchema.strict()
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
      _meta: { "issue-tracker/groups": ["admin"] },
      title: "Create issue from template",
      description: "Create an issue from a named template with optional overrides.",
      inputSchema: createIssueFromTemplateInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createIssueFromTemplateInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) => {
        const created = createIssueFromTemplate(
          context,
          parsed.name,
          parsed.overrides
        );
        return jsonResult({ ...serializeIssue(created), alreadyExisted: created.alreadyExisted });
      });
    })
  );
}
