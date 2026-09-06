import {
  claimIssue,
  claimIssueInputSchema,
  issueResponseSchema,
  serializeIssueMutation,
  withIssueMutationReceipt,
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
  server.registerTool("claim_issue", { title: "Claim issue", description: "Atomically claim active unassigned backlog/unstarted work for the current actor. Claims have no lease; release through assign_issue with actor:null. Conflicts require a fresh read.", inputSchema: claimIssueInputSchema }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(serializeIssue(claimIssue(context, input.identifier, input))))));

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
      inputSchema: listIssuesPageWithViewToolInputSchema.strict()
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
      inputSchema: searchPageInputSchema.strict()
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
      description: "Read one issue by identifier. Comments default to the latest 10; use comments: 'all' for full fidelity or commentCursor/commentLimit to page oldest to newest.",
      inputSchema: getIssueInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = getIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeIssue(getIssue(context, parsed.identifier, parsed)))
      );
    })
  );

  server.registerTool(
    "list_activity",
    {
      title: "List issue activity",
      description: "Read the ordered activity trail for an issue.",
      inputSchema: listActivityInputSchema.strict()
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
      description:
        "Create an issue. Pass an optional global `idempotencyKey` to make retries safe: " +
        "re-submitting the same key returns the original issue with `alreadyExisted: true` " +
        "instead of filing a duplicate. A deduped result reflects the original issue's current " +
        "state (it may have been edited or archived since it was created).",
      inputSchema: createIssueInputSchema.safeExtend({ response: issueResponseSchema.optional() })
    },
    (input) => mcpToolResult(() => {
      const parsed = createIssueInputSchema.parse(withoutResponse(input));
      return withMcpContext({ ...options, requireActor: true }, ({ context }) => {
        const created = withIssueMutationReceipt(context, null, (tx) => createIssue(tx, parsed));
        return jsonResult(serializeIssueMutation(created, input.response));
      });
    })
  );

  server.registerTool(
    "update_issue",
    {
      title: "Update issue",
      description: "Update issue fields.",
      inputSchema: updateIssueToolInputSchema.safeExtend({ response: issueResponseSchema.optional() })
    },
    (input) => mcpToolResult(() => {
      const { identifier, ...update } = updateIssueToolInputSchema.parse(withoutResponse(input));
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssueMutation(withIssueMutationReceipt(context, identifier, (tx) => updateIssue(tx, identifier, update)), input.response))
      );
    })
  );

  server.registerTool(
    "move_issue",
    {
      title: "Move issue",
      description: "Move an issue to another workflow state.",
      inputSchema: moveIssueInputSchema.safeExtend({ response: issueResponseSchema.optional() })
    },
    (input) => mcpToolResult(() => {
      const parsed = moveIssueInputSchema.parse(withoutResponse(input));
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssueMutation(withIssueMutationReceipt(context, parsed.identifier, (tx) => moveIssue(tx, parsed.identifier, parsed.state, parsed)), input.response))
      );
    })
  );

  server.registerTool(
    "assign_issue",
    {
      title: "Assign issue",
      description: "Assign or clear an issue assignee.",
      inputSchema: assignIssueInputSchema.safeExtend({ response: issueResponseSchema.optional() })
    },
    (input) => mcpToolResult(() => {
      const parsed = assignIssueInputSchema.parse(withoutResponse(input));
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssueMutation(withIssueMutationReceipt(context, parsed.identifier, (tx) => assignIssue(tx, parsed.identifier, parsed.actor, parsed)), input.response))
      );
    })
  );

  server.registerTool(
    "archive_issue",
    {
      title: "Archive issue",
      description: "Archive an issue without deleting it.",
      inputSchema: archiveIssueInputSchema.safeExtend({ response: issueResponseSchema.optional() })
    },
    (input) => mcpToolResult(() => {
      const parsed = archiveIssueInputSchema.parse(withoutResponse(input));
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssueMutation(withIssueMutationReceipt(context, parsed.identifier, (tx) => archiveIssue(tx, parsed.identifier, parsed)), input.response))
      );
    })
  );

  server.registerTool(
    "unarchive_issue",
    {
      title: "Unarchive issue",
      description: "Restore an archived issue.",
      inputSchema: unarchiveIssueInputSchema.safeExtend({ response: issueResponseSchema.optional() })
    },
    (input) => mcpToolResult(() => {
      const parsed = unarchiveIssueInputSchema.parse(withoutResponse(input));
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeIssueMutation(withIssueMutationReceipt(context, parsed.identifier, (tx) => unarchiveIssue(tx, parsed.identifier, parsed)), input.response))
      );
    })
  );

  server.registerTool(
    "comment_on_issue",
    {
      title: "Comment on issue",
      description: "Add a comment to an issue.",
      inputSchema: addCommentInputSchema.strict()
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
      inputSchema: linkIssueToolInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = linkIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeAttachment(addAttachment(context, parsed)))
      );
    })
  );
}

function withoutResponse<T extends { response?: unknown }>(input: T): Omit<T, "response"> {
  const fields = { ...input };
  delete fields.response;
  return fields;
}
