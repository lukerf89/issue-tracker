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
  updateProjectToolInputSchema
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
      inputSchema: listProjectsInputSchema.strict()
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
      inputSchema: getProjectInputSchema.strict()
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
      inputSchema: createProjectInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = createProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeProject(createProject(context, parsed)))
      );
    })
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description: "Update project fields.",
      inputSchema: updateProjectToolInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const { project, ...update } = updateProjectToolInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: true }, ({ context }) =>
        jsonResult(serializeProject(updateProject(context, project, update)))
      );
    })
  );

  server.registerTool(
    "archive_project",
    {
      title: "Archive project",
      description: "Archive a project without deleting it.",
      inputSchema: archiveProjectInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = archiveProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeProject(archiveProject(context, parsed.project)))
      );
    })
  );

  server.registerTool(
    "unarchive_project",
    {
      title: "Unarchive project",
      description: "Restore an archived project.",
      inputSchema: unarchiveProjectInputSchema.strict()
    },
    (input) => mcpToolResult(() => {
      const parsed = unarchiveProjectInputSchema.parse(input);
      return withMcpContext({ ...options, requireActor: false }, ({ context }) =>
        jsonResult(serializeProject(unarchiveProject(context, parsed.project)))
      );
    })
  );
}
