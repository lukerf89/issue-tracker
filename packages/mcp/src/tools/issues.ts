import {
  addAttachment,
  addComment,
  addCommentInputSchema,
  archiveIssue,
  archiveIssueInputSchema,
  assignIssue,
  assignIssueInputSchema,
  createIssue,
  createIssueInputSchema,
  getIssue,
  getIssueInputSchema,
  listActivity,
  listActivityInputSchema,
  linkIssueInputSchema,
  linkIssueToolInputSchema,
  listIssuesPageWithView,
  listIssuesPageWithViewToolInputSchema,
  searchIssuesPage,
  searchPageInputSchema,
  moveIssue,
  moveIssueInputSchema,
  serializeActivity,
  serializeAttachment,
  serializeComment,
  serializeIssue,
  serializeIssueSummary,
  unarchiveIssue,
  unarchiveIssueInputSchema,
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
      description:
        "Query issues with optional filters. Returns a compact summary page " +
        "({issues, nextCursor}); each issue carries identifier, title, stateId, " +
        "priority, assigneeId, updatedAt. Use `fields` to project extra columns " +
        "(e.g. description, labels), `limit`/`cursor` to paginate, and get_issue " +
        "for full fidelity incl. comments/attachments.",
      inputSchema: listIssuesPageWithViewToolInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const { view, cursor, fields, ...filters } =
        listIssuesPageWithViewToolInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) => {
        const page = listIssuesPageWithView(context, { view, filters, cursor, fields });
        return jsonResult({
          issues: page.rows.map((row) => serializeIssueSummary(row.issue, row.fields)),
          nextCursor: page.nextCursor
        });
      });
    })
  );

  server.registerTool(
    "search",
    {
      title: "Search issues",
      description:
        "Search issues by full-text (FTS5) over identifier, title, and " +
        "description. Returns a compact summary page ({issues, nextCursor}) " +
        "ranked by bm25 relevance; each issue carries a `snippet` excerpt of " +
        "the match. Supports prefix and multi-token queries and composes with " +
        "the standard filters; use `fields` to project extra columns and " +
        "`limit`/`cursor` to paginate.",
      inputSchema: searchPageInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const { cursor, fields, ...rest } = searchPageInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) => {
        const page = searchIssuesPage(context, rest, { cursor, fields });
        return jsonResult({
          issues: page.rows.map((row) => serializeIssueSummary(row.issue, row.fields, row.snippet)),
          nextCursor: page.nextCursor
        });
      });
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
    "archive_issue",
    {
      title: "Archive issue",
      description: "Archive an issue without deleting it.",
      inputSchema: archiveIssueInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = archiveIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssue(archiveIssue(context, parsed.identifier)))
      );
    })
  );

  server.registerTool(
    "unarchive_issue",
    {
      title: "Unarchive issue",
      description: "Restore an archived issue.",
      inputSchema: unarchiveIssueInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = unarchiveIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssue(unarchiveIssue(context, parsed.identifier)))
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

  server.registerTool(
    "link_issue",
    {
      title: "Link issue",
      description: "Attach a branch, PR, commit, or URL to an issue.",
      inputSchema: linkIssueToolInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = linkIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeAttachment(addAttachment(context, parsed)))
      );
    })
  );
}
