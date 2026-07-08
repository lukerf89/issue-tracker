import {
  AppError,
  AppErrorCode,
  createActor,
  createActorInputSchema,
  listActors,
  listActorsInputSchema,
  serializeActor
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerActorTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  registerCurrentActorTool(server, options, "whoami");
  registerCurrentActorTool(server, options, "get_current_actor");

  server.registerTool(
    "create_actor",
    {
      title: "Create actor",
      description: "Create a human or agent actor.",
      inputSchema: createActorInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = createActorInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeActor(createActor(context, parsed)))
      );
    })
  );

  server.registerTool(
    "list_actors",
    {
      title: "List actors",
      description: "List actors.",
      inputSchema: listActorsInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listActorsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listActors(context, parsed).map(serializeActor))
      );
    })
  );
}

function registerCurrentActorTool(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">,
  name: "whoami" | "get_current_actor"
): void {
  server.registerTool(
    name,
    {
      title: "Get current actor",
      description: "Return the resolved calling actor.",
      inputSchema: {}
    },
    () => mcpToolResult(() =>
      withMcpContext({ ...options, requireActor: true }, ({ context }) => {
        if (!context.actor) {
          throw new AppError(
            AppErrorCode.ACTOR_NOT_FOUND,
            "MCP mutations require an agent actor handle."
          );
        }

        return jsonResult(serializeActor(context.actor));
      })
    )
  );
}
