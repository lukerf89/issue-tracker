import {
  addComment,
  addCommentInputSchema,
  createIssue,
  createIssueInputSchema,
  getIssue,
  getIssueInputSchema,
  listIssueFiltersSchema,
  listIssues,
  moveIssue,
  moveIssueInputSchema,
  serializeComment,
  serializeIssue,
  updateIssue,
  updateIssueToolInputSchema
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerIssueTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description: "Query issues with optional filters.",
      inputSchema: listIssueFiltersSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listIssueFiltersSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listIssues(context, parsed).map(serializeIssue))
      );
    })
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get issue",
      description: "Read one issue by identifier.",
      inputSchema: getIssueInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = getIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeIssue(getIssue(context, parsed.identifier)))
      );
    })
  );

  server.registerTool(
    "create_issue",
    {
      title: "Create issue",
      description: "Create an issue.",
      inputSchema: createIssueInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = createIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssue(createIssue(context, parsed)))
      );
    })
  );

  server.registerTool(
    "update_issue",
    {
      title: "Update issue",
      description: "Update issue fields.",
      inputSchema: updateIssueToolInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const { identifier, ...update } = updateIssueToolInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssue(updateIssue(context, identifier, update)))
      );
    })
  );

  server.registerTool(
    "move_issue",
    {
      title: "Move issue",
      description: "Move an issue to another workflow state.",
      inputSchema: moveIssueInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = moveIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssue(moveIssue(context, parsed.identifier, parsed.state)))
      );
    })
  );

  server.registerTool(
    "comment_on_issue",
    {
      title: "Comment on issue",
      description: "Add a comment to an issue.",
      inputSchema: addCommentInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = addCommentInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeComment(addComment(context, parsed)))
      );
    })
  );
}
