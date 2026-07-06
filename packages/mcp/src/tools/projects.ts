import {
  createProject,
  createProjectInputSchema,
  getProject,
  getProjectInputSchema,
  listProjects,
  listProjectsInputSchema,
  serializeProject
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerProjectTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List projects.",
      inputSchema: listProjectsInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = listProjectsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(listProjects(context, parsed).map(serializeProject))
      );
    })
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Read one project by id or name.",
      inputSchema: getProjectInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = getProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeProject(getProject(context, parsed.project)))
      );
    })
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: "Create a project.",
      inputSchema: createProjectInputSchema.shape
    },
    (input) => mcpToolResult(() => {
      const parsed = createProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeProject(createProject(context, parsed)))
      );
    })
  );
}
