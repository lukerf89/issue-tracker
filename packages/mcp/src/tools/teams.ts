import {
  listTeams,
  listTeamsInputSchema,
  serializeTeam
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { openMcpContext, type OpenMcpContextOptions } from "../context.js";
import { jsonResult } from "./result.js";

export function registerTeamTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_teams",
    {
      title: "List teams",
      description: "List teams.",
      inputSchema: listTeamsInputSchema.shape
    },
    (input) => {
      const parsed = listTeamsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listTeams(context, parsed).map(serializeTeam))
      );
    }
  );
}

function withMcpContext<T>(
  options: OpenMcpContextOptions,
  work: (mcp: ReturnType<typeof openMcpContext>) => T
): T {
  const mcp = openMcpContext(options);

  try {
    return work(mcp);
  } finally {
    mcp.close();
  }
}
