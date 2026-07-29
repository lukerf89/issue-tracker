import {
  describeTracker,
  describeTrackerInputSchema,
  listStatesForTeam,
  listStatesInputSchema,
  serializeWorkflowState
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerMetadataTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "describe",
    {
      title: "Describe tracker metadata",
      description: "Discover teams, workflow states, priorities, labels, projects, and the current actor.",
      inputSchema: describeTrackerInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      describeTrackerInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(describeTracker(context))
      );
    })
  );

  server.registerTool(
    "list_states",
    {
      title: "List workflow states",
      description: "List ordered workflow states for a team id or key.",
      inputSchema: listStatesInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listStatesInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listStatesForTeam(context, parsed.team).map(serializeWorkflowState))
      );
    })
  );
}
