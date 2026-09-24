import {
  claimIssue,
  claimIssueInputSchema,
  issueResponseSchema,
  serializeIssueMutation,
  withIssueMutationReceipt,
  getIssueResponse, getIssuesResponse, readIssueSection, getIssuesInputSchema, readIssueSectionInputSchema,
  getWorkContext, getWorkContextInputSchema,
  addAttachment,
  addComment,
  addCommentInputSchema,
  archiveIssue,
  archiveIssueInputSchema,
  assignIssue,
  assignIssueInputSchema,
  createIssue,
  createIssueInputSchema,
  getIssueInputSchema,
  listActivity,
  listActivityPageInputSchema,
  listActivitySince,
  listActivitySinceInputSchema,
  listIssueActivityPage,
  linkIssueInputSchema,
  linkIssueToolInputSchema,
  listIssuesPageWithView,
  listIssuesPageWithViewToolInputSchema,
  searchIssuesPage,
  searchPageInputSchema,
  moveIssue,
  moveIssueInputSchema,
  serializeActivity,
  serializeActivityFeed,
  serializeActivityPage,
  serializeAttachmentMutation,
  serializeCommentMutation,
  serializeIssue,
  serializeIssueSummary,
  unarchiveIssue,
  unarchiveIssueInputSchema,
  updateIssue,
  updateIssueToolInputSchema,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerIssueTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool("get_issues", {
      _meta: toolGroups("coding"), title: "Read selected issues", description: "Read up to ten known issues under a total JSON byte budget. Omitted fields remain retrievable with read_issue_section.", inputSchema: getIssuesInputSchema }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getIssuesResponse(context, input)))));
  server.registerTool("read_issue_section", {
      _meta: toolGroups("coding"), title: "Read issue section", description: "Page a string or collection independently. Follow nextCursor; retrieve oversized values through omittedPaths. Pass snapshot to reject changed source content.", inputSchema: readIssueSectionInputSchema }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(readIssueSection(context, input)))));

  server.registerTool("get_work_context", {
      _meta: toolGroups("coding"), title: "Read work context", description: "Deterministic, bounded work context for an issue: task, full acceptance criteria (Done when / Acceptance criteria lists), blockers, parent, repository routing, decisions (comments starting \"Decision:\" or \"Decided:\") and recent comments. Every section has provenance and a retrieval path; omissions list what the byte budget or selection limits left out. Pass run to read the immutable snapshot a run launched with plus stale source revisions (maxBytes is live-only).", inputSchema: getWorkContextInputSchema }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getWorkContext(context, input)))));
  server.registerTool("claim_issue", {
      _meta: toolGroups("coding"), title: "Claim issue", description: "Atomically claim active unassigned backlog/unstarted work for the current actor. Claims have no lease; release through assign_issue with actor:null. Conflicts require a fresh read.", inputSchema: claimIssueInputSchema }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(serializeIssue(claimIssue(context, input.identifier, input))))));

  server.registerTool(
    "list_issues",
    {
      _meta: toolGroups("coding"),
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
          issues: page.rows.map((row) => serializeIssueSummary(row.issue, row.fields, row.snippet)),
          nextCursor: page.nextCursor
        });
      });
    })
  );

  server.registerTool(
    "search",
    {
      _meta: toolGroups("coding"),
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
      _meta: toolGroups("coding"),
      title: "Get issue",
      description: "Read one issue by identifier. Use fields/maxBytes for bounded selection with explicit omissions. For independently paged complete comments use read_issue_section path:[comments]. Legacy comments default to the latest 10; use comments: 'all' for full fidelity or commentCursor/commentLimit to page oldest to newest.",
      inputSchema: getIssueInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = getIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(getIssueResponse(context, parsed))
      );
    })
  );

  server.registerTool(
    "list_activity",
    {
      _meta: toolGroups("admin"),
      title: "List issue activity",
      description:
        "Read one issue's activity trail as a bounded page in append order: " +
        "{issue, entries, cursor, hasMore}. Default limit 50 (max 500). Pass `after: cursor` " +
        "and call again while hasMore is true; pages never skip or duplicate entries. " +
        "`full: true` returns the legacy complete bare array (createdAt then append order) " +
        "and cannot be combined with after or limit.",
      inputSchema: listActivityPageInputSchema
    },
    (input) => mcpToolResult(() => {
      const parsed = listActivityPageInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(
          parsed.full === true
            ? listActivity(context, { issue: parsed.issue }).map(serializeActivity)
            : serializeActivityPage(listIssueActivityPage(context, parsed))
        )
      );
    })
  );

  server.registerTool(
    "list_activity_feed",
    {
      _meta: toolGroups("coding"),
      title: "List activity feed",
      description:
        "Incremental activity feed across issues in append order: {events, cursor, hasMore}. " +
        "Default limit 100 (max 500). Persist `cursor` and call again with it while hasMore is " +
        "true; resuming from a persisted cursor with the same filters yields no gaps and no " +
        "duplicates. Filters (team, assignee, issue, project) apply to CURRENT issue attributes " +
        "at query time. The cursor is a high-water mark: every event at or below it is " +
        "permanently skipped, including events that did not match the filters then. A cursor " +
        "ahead of the log fails with VALIDATION_FAILED (details.latestCursor); after an import, " +
        "restart without a cursor.",
      inputSchema: listActivitySinceInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = listActivitySinceInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeActivityFeed(listActivitySince(context, parsed)))
      );
    })
  );

  server.registerTool(
    "create_issue",
    {
      _meta: toolGroups("coding"),
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
      _meta: toolGroups("coding"),
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
      _meta: toolGroups("coding"),
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
      _meta: toolGroups("coding"),
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
      _meta: toolGroups("admin"),
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
      _meta: toolGroups("admin"),
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
      _meta: toolGroups("coding"),
      title: "Comment on issue",
      description:
        "Add a comment to an issue. Optional idempotencyKey (global to comments; trimmed; blank means no key): " +
        "a retry with the same key and the same issue/author/body/parent returns the stored comment with " +
        "alreadyExisted: true, writing nothing and skipping the expectedRevision check; the same key with a " +
        "different payload fails with IDEMPOTENCY_KEY_CONFLICT. alreadyExisted is false on a fresh write.",
      inputSchema: addCommentInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = addCommentInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeCommentMutation(addComment(context, parsed)))
      );
    })
  );

  server.registerTool(
    "link_issue",
    {
      _meta: toolGroups("coding"),
      title: "Link issue",
      description:
        "Attach a branch, PR, commit, or URL to an issue. Optional idempotencyKey (global to attachments; " +
        "trimmed; blank means no key): a retry with the same key and the same issue/kind/title/url/repoPath/" +
        "remote/branchName/commitSha returns the stored attachment with alreadyExisted: true, writing nothing " +
        "and skipping the expectedRevision check; the same key with a different payload fails with " +
        "IDEMPOTENCY_KEY_CONFLICT. alreadyExisted is false on a fresh write.",
      inputSchema: linkIssueToolInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = linkIssueInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeAttachmentMutation(addAttachment(context, parsed)))
      );
    })
  );
}

function withoutResponse<T extends { response?: unknown }>(input: T): Omit<T, "response"> {
  const fields = { ...input };
  delete fields.response;
  return fields;
}
