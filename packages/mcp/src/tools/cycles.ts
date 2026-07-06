import {
  listCycles,
  listCyclesInputSchema,
  serializeCycle
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerCycleTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_cycles",
    {
      title: "List cycles",
      description: "List cycles.",
      inputSchema: listCyclesInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listCyclesInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listCycles(context, parsed).map(serializeCycle))
      );
    })
  );
}
