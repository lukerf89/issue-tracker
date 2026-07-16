import {
  AppErrorCode,
  errorEnvelope,
  getIssue,
  listIssuesPage,
  serializeIssue,
  serializeIssueSummary
} from "@issue-tracker/core";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { OpenMcpContextOptions } from "../context.js";
import { withMcpContext } from "../tools/result.js";

export function registerIssueResources(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerResource(
    "issue",
    new ResourceTemplate("issue://{identifier}", { list: undefined }),
    {
      title: "Issue",
      description: "Read one issue by identifier.",
      mimeType: "application/json"
    },
    (uri) =>
      jsonResource(uri, () =>
        withMcpContext({ ...options, requireActor: false }, ({ context }) =>
          serializeIssue(getIssue(context, authoritySegment(uri)))
        )
      )
  );

  server.registerResource(
    "backlog",
    new ResourceTemplate("backlog://{team}", { list: undefined }),
    {
      title: "Backlog",
      description: "Read the current non-archived backlog for a team.",
      mimeType: "application/json"
    },
    (uri) =>
      jsonResource(uri, () =>
        withMcpContext({ ...options, requireActor: false }, ({ context }) => {
          const page = listIssuesPage(context, { team: authoritySegment(uri) });
          return {
            issues: page.rows.map((row) => serializeIssueSummary(row.issue, row.fields)),
            nextCursor: page.nextCursor
          };
        })
      )
  );
}

function jsonResource(uri: URL, work: () => unknown) {
  try {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(work())
        }
      ]
    };
  } catch (error) {
    const envelope = errorEnvelope(error);
    const code =
      envelope.error.code === AppErrorCode.DATABASE_ERROR
        ? ErrorCode.InternalError
        : ErrorCode.InvalidParams;

    throw new McpError(code, envelope.error.message, envelope);
  }
}

function authoritySegment(uri: URL): string {
  return decodeURIComponent(uri.host);
}
