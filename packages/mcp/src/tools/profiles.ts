import { addProfile, addProfileInputSchema, archiveProfile, getProfile, listProfiles, listProfilesInputSchema, profileRefSchema, setDefaultProfile } from "@issue-tracker/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OpenMcpContextOptions } from "../context.js";
import { jsonResult, mcpToolResult, withMcpContext } from "./result.js";

export function registerProfileTools(server: McpServer, options: Omit<OpenMcpContextOptions, "requireActor">) {
  server.registerTool("list_orchestration_profiles", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "List profiles", description: "List orchestration profiles.", inputSchema: listProfilesInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(listProfiles(context, listProfilesInputSchema.parse(input))))));
  server.registerTool("get_orchestration_profile", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "Get profile", description: "Read an orchestration profile.", inputSchema: profileRefSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: false }, ({ context }) => jsonResult(getProfile(context, profileRefSchema.parse(input).profile)))));
  server.registerTool("add_orchestration_profile", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "Add profile", description: "Create an orchestration profile.", inputSchema: addProfileInputSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(addProfile(context, addProfileInputSchema.parse(input))))));
  server.registerTool("archive_orchestration_profile", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "Archive profile", description: "Archive an orchestration profile.", inputSchema: profileRefSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(archiveProfile(context, profileRefSchema.parse(input).profile)))));
  server.registerTool("set_default_orchestration_profile", {
      _meta: { "issue-tracker/groups": ["orchestration"] }, title: "Set default profile", description: "Set the default orchestration profile.", inputSchema: profileRefSchema.strict() }, (input) => mcpToolResult(() => withMcpContext({ ...options, requireActor: true }, ({ context }) => jsonResult(setDefaultProfile(context, profileRefSchema.parse(input).profile)))));
}
