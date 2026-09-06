import {
  addRepository, addRepositoryInputSchema, archiveRepository, associateRepository,
  associateRepositoryInputSchema, createNodeRepositoryInspector, getRepository,
  listRepositories, listRepositoriesInputSchema, repositoryRefSchema
} from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerRepositoryTools(server: McpServer, options: Omit<OpenMcpContextOptions, "requireActor">) {
  server.registerTool("list_repositories", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "List repositories", description: "List registered repositories.", inputSchema: listRepositoriesInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listRepositories(context, listRepositoriesInputSchema.parse(input))))));
  server.registerTool("get_repository", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "Get repository", description: "Read a registered repository.", inputSchema: repositoryRefSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getRepository(context, repositoryRefSchema.parse(input).repository)))));
  server.registerTool("add_repository", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "Add repository", description: "Validate and register a local Git repository.", inputSchema: addRepositoryInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(addRepository(context, addRepositoryInputSchema.parse(input), createNodeRepositoryInspector())))));
  server.registerTool("archive_repository", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "Archive repository", description: "Archive a registered repository.", inputSchema: repositoryRefSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(archiveRepository(context, repositoryRefSchema.parse(input).repository)))));
  server.registerTool("associate_repository", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "Associate repository", description: "Associate a repository with a project or issue.", inputSchema: associateRepositoryInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(associateRepository(context, associateRepositoryInputSchema.parse(input))))));
}
