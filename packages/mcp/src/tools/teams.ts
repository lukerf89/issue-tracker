import {
  archiveTeam,
  archiveTeamInputSchema,
  createTeam,
  createTeamInputSchema,
  listTeams,
  listTeamsInputSchema,
  serializeTeam,
  unarchiveTeam,
  unarchiveTeamInputSchema
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerTeamTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "create_team",
    {
      title: "Create team",
      description: "Create a team with default workflow states.",
      inputSchema: createTeamInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = createTeamInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeTeam(createTeam(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_teams",
    {
      title: "List teams",
      description: "List teams.",
      inputSchema: listTeamsInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listTeamsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listTeams(context, parsed).map(serializeTeam))
      );
    })
  );

  server.registerTool(
    "archive_team",
    {
      title: "Archive team",
      description: "Archive a team without deleting it.",
      inputSchema: archiveTeamInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = archiveTeamInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeTeam(archiveTeam(context, parsed.team)))
      );
    })
  );

  server.registerTool(
    "unarchive_team",
    {
      title: "Unarchive team",
      description: "Restore an archived team.",
      inputSchema: unarchiveTeamInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = unarchiveTeamInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeTeam(unarchiveTeam(context, parsed.team)))
      );
    })
  );
}
