import { addProfile, addProfileInputSchema, archiveProfile, getProfile, listProfiles, listProfilesInputSchema, profileRefSchema, setDefaultProfile, toolGroups } from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { mcpToolResult, toolConfig, toolResult, withMcpContext } from "./result.js";

export function registerProfileTools(server: McpServer, options: Omit<OpenMcpContextOptions, "requireActor">) {
  server.registerTool("list_orchestration_profiles", {
      _meta: toolGroups("orchestration"), ...toolConfig("list_orchestration_profiles"), description: "List orchestration profiles.", inputSchema: listProfilesInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false, tool: "list_orchestration_profiles" }, ({ context }) => toolResult("list_orchestration_profiles", listProfiles(context, listProfilesInputSchema.parse(input))))));
  server.registerTool("get_orchestration_profile", {
      _meta: toolGroups("orchestration"), ...toolConfig("get_orchestration_profile"), description: "Read an orchestration profile.", inputSchema: profileRefSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false, tool: "get_orchestration_profile" }, ({ context }) => toolResult("get_orchestration_profile", getProfile(context, profileRefSchema.parse(input).profile)))));
  server.registerTool("add_orchestration_profile", {
      _meta: toolGroups("orchestration"), ...toolConfig("add_orchestration_profile"), description: "Create an orchestration profile.", inputSchema: addProfileInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true, tool: "add_orchestration_profile" }, ({ context }) => toolResult("add_orchestration_profile", addProfile(context, addProfileInputSchema.parse(input))))));
  server.registerTool("archive_orchestration_profile", {
      _meta: toolGroups("orchestration"), ...toolConfig("archive_orchestration_profile"), description: "Archive an orchestration profile.", inputSchema: profileRefSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true, tool: "archive_orchestration_profile" }, ({ context }) => toolResult("archive_orchestration_profile", archiveProfile(context, profileRefSchema.parse(input).profile)))));
  server.registerTool("set_default_orchestration_profile", {
      _meta: toolGroups("orchestration"), ...toolConfig("set_default_orchestration_profile"), description: "Set the default orchestration profile.", inputSchema: profileRefSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true, tool: "set_default_orchestration_profile" }, ({ context }) => toolResult("set_default_orchestration_profile", setDefaultProfile(context, profileRefSchema.parse(input).profile)))));
}
