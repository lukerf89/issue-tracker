import {
  addRepository, addRepositoryInputSchema, archiveRepository, associateRepository,
  associateRepositoryInputSchema, createNodeRepositoryInspector, getRepository,
  listRepositories, listRepositoriesInputSchema, repositoryRefSchema
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerRepositoryTools(server: McpServer, options: Omit<OpenMcpContextOptions, "requireActor">) {
  server.registerTool("list_repositories", { title: "List repositories", description: "List registered repositories.", inputSchema: listRepositoriesInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listRepositories(context, listRepositoriesInputSchema.parse(input))))));
  server.registerTool("get_repository", { title: "Get repository", description: "Read a registered repository.", inputSchema: repositoryRefSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getRepository(context, repositoryRefSchema.parse(input).repository)))));
  server.registerTool("add_repository", { title: "Add repository", description: "Validate and register a local Git repository.", inputSchema: addRepositoryInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(addRepository(context, addRepositoryInputSchema.parse(input), createNodeRepositoryInspector())))));
  server.registerTool("archive_repository", { title: "Archive repository", description: "Archive a registered repository.", inputSchema: repositoryRefSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(archiveRepository(context, repositoryRefSchema.parse(input).repository)))));
  server.registerTool("associate_repository", { title: "Associate repository", description: "Associate a repository with a project or issue.", inputSchema: associateRepositoryInputSchema.shape }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(associateRepository(context, associateRepositoryInputSchema.parse(input))))));
}
