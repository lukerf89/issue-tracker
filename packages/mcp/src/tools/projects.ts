import {
  archiveProject,
  archiveProjectInputSchema,
  createProject,
  createProjectInputSchema,
  getProject,
  getProjectInputSchema,
  listProjects,
  listProjectsInputSchema,
  serializeProject,
  unarchiveProject,
  unarchiveProjectInputSchema,
  updateProject,
  updateProjectToolInputSchema,
  toolGroups
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { mcpToolResult, toolConfig, toolResult, withMcpContext } from "./result.js";

export function registerProjectTools(
  server: McpServer,
  options: Omit<OpenMcpContextOptions, "requireActor">
): void {
  server.registerTool(
    "list_projects",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("list_projects"),
      description: "List projects.",
      inputSchema: listProjectsInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = listProjectsInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "list_projects" }, ({ context }) =>
        toolResult("list_projects", listProjects(context, parsed).map(serializeProject))
      );
    })
  );

  server.registerTool(
    "get_project",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("get_project"),
      description: "Read one project by id or name.",
      inputSchema: getProjectInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = getProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "get_project" }, ({ context }) =>
        toolResult("get_project", serializeProject(getProject(context, parsed.project)))
      );
    })
  );

  server.registerTool(
    "create_project",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("create_project"),
      description: "Create a project.",
      inputSchema: createProjectInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "create_project" }, ({ context }) =>
        toolResult("create_project", serializeProject(createProject(context, parsed)))
      );
    })
  );

  server.registerTool(
    "update_project",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("update_project"),
      description: "Update project fields.",
      inputSchema: updateProjectToolInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const { project, ...update } = updateProjectToolInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true, tool: "update_project" }, ({ context }) =>
        toolResult("update_project", serializeProject(updateProject(context, project, update)))
      );
    })
  );

  server.registerTool(
    "archive_project",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("archive_project"),
      description: "Archive a project without deleting it.",
      inputSchema: archiveProjectInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = archiveProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "archive_project" }, ({ context }) =>
        toolResult("archive_project", serializeProject(archiveProject(context, parsed.project)))
      );
    })
  );

  server.registerTool(
    "unarchive_project",
    {
      _meta: toolGroups("admin"),
      ...toolConfig("unarchive_project"),
      description: "Restore an archived project.",
      inputSchema: unarchiveProjectInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = unarchiveProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false, tool: "unarchive_project" }, ({ context }) =>
        toolResult("unarchive_project", serializeProject(unarchiveProject(context, parsed.project)))
      );
    })
  );
}
