import {
  archiveTeam,
  archiveTeamInputSchema,
  createTeam,
  createTeamInputSchema,
  listTeams,
  listTeamsInputSchema,
  serializeTeam,
  unarchiveTeam,
  unarchiveTeamInputSchema,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { mcpToolResult, toolConfig, toolResult, withMcpContext } from "./result.js";

export function registerTeamTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "create_team",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("create_team"),
      description: "Create a team with default workflow states.",
      inputSchema: createTeamInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createTeamInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "create_team" }, ({ context }) =>
        toolResult("create_team", serializeTeam(createTeam(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_teams",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("list_teams"),
      description: "List teams.",
      inputSchema: listTeamsInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = listTeamsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "list_teams" }, ({ context }) =>
        toolResult("list_teams", listTeams(context, parsed).map(serializeTeam))
      );
    })
  );

  server.registerTool(
    "archive_team",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("archive_team"),
      description: "Archive a team without deleting it.",
      inputSchema: archiveTeamInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = archiveTeamInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "archive_team" }, ({ context }) =>
        toolResult("archive_team", serializeTeam(archiveTeam(context, parsed.team)))
      );
    })
  );

  server.registerTool(
    "unarchive_team",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("unarchive_team"),
      description: "Restore an archived team.",
      inputSchema: unarchiveTeamInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = unarchiveTeamInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "unarchive_team" }, ({ context }) =>
        toolResult("unarchive_team", serializeTeam(unarchiveTeam(context, parsed.team)))
      );
    })
  );
}
