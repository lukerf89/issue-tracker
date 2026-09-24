import {
  describeTracker,
  describeTrackerInputSchema,
  listStatesForTeam,
  listStatesInputSchema,
  serializeWorkflowState,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { mcpToolResult, toolConfig, toolResult, withMcpContext } from "./result.js";

export function registerMetadataTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "describe",
    {
      _meta: toolGroups("coding"),
      ...toolConfig("describe"),
      description: "Discover teams, workflow states, priorities, labels, projects, and the current actor. Scope with team and sections; compact trims project references. Re-read only when metadataRevision changes.",
      inputSchema: describeTrackerInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = describeTrackerInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "describe" }, ({ context }) =>
        toolResult("describe", describeTracker(context, parsed))
      );
    })
  );

  server.registerTool(
    "list_states",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("list_states"),
      description: "List ordered workflow states for a team id or key.",
      inputSchema: listStatesInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = listStatesInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "list_states" }, ({ context }) =>
        toolResult("list_states", listStatesForTeam(context, parsed.team).map(serializeWorkflowState))
      );
    })
  );
}
