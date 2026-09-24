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
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerCycleTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "create_cycle",
    {
      _meta: toolGroups("admin"),
      title: "Create cycle",
      description: "Create a cycle.",
      inputSchema: createCycleInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createCycleInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeCycle(createCycle(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_cycles",
    {
      _meta: toolGroups("admin"),
      title: "List cycles",
      description: "List cycles.",
      inputSchema: listCyclesInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = listCyclesInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listCycles(context, parsed).map(serializeCycle))
      );
    })
  );
}
