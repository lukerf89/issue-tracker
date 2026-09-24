import {
  createCycle,
  createCycleInputSchema,
  listCycles,
  listCyclesInputSchema,
  serializeCycle,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { mcpToolResult, toolConfig, toolResult, withMcpContext } from "./result.js";

export function registerCycleTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "create_cycle",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("create_cycle"),
      description: "Create a cycle.",
      inputSchema: createCycleInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createCycleInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "create_cycle" }, ({ context }) =>
        toolResult("create_cycle", serializeCycle(createCycle(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_cycles",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("list_cycles"),
      description: "List cycles.",
      inputSchema: listCyclesInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = listCyclesInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "list_cycles" }, ({ context }) =>
        toolResult("list_cycles", listCycles(context, parsed).map(serializeCycle))
      );
    })
  );
}
