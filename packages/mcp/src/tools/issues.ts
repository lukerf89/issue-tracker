import {
  addComment,
  addCommentInputSchema,
  assignIssue,
  assignIssueInputSchema,
  createIssue,
  createIssueInputSchema,
  getIssue,
  getIssueInputSchema,
  listActivity,
  listActivityInputSchema,
  listIssueFiltersSchema,
  listIssues,
  moveIssue,
  moveIssueInputSchema,
  searchInputSchema,
  searchIssues,
  serializeActivity,
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
    "search",
    {
      title: "Search issues",
      description: "Search issues by title or description text.",
      inputSchema: searchInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = searchInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(searchIssues(context, parsed).map(serializeIssue))
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
    "list_activity",
    {
      title: "List issue activity",
      description: "Read the ordered activity trail for an issue.",
      inputSchema: listActivityInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listActivityInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listActivity(context, parsed).map(serializeActivity))
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
    "assign_issue",
    {
      title: "Assign issue",
      description: "Assign or clear an issue assignee.",
      inputSchema: assignIssueInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = assignIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssue(assignIssue(context, parsed.identifier, parsed.actor)))
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
