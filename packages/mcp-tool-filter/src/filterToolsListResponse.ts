import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { ORCHESTRATION_TOOL_NAME_SET } from "./orchestrationTools.js";

interface ToolsListLikeResult {
  tools: ReadonlyArray<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Identity-passthrough-by-default filter for a single JSON-RPC message
 * flowing from the real tracker MCP server to the client.
 *
 * Only messages that look like a `tools/list` *response* (a JSON-RPC
 * response carrying a `result.tools` array) are transformed: tool entries
 * whose `name` is in the run-orchestration set are removed. Every other
 * message (requests, notifications, other responses, `tools/call` results,
 * resource traffic, etc.) is returned unchanged — this is purely a
 * schema-advertisement filter, not a permission or execution filter.
 */
export function filterToolsListResponse(message: JSONRPCMessage): JSONRPCMessage {
  if (!isToolsListResponse(message)) {
    return message;
  }

  const result = message.result;
  const filteredTools = result.tools.filter((tool) => !ORCHESTRATION_TOOL_NAME_SET.has(tool.name));

  if (filteredTools.length === result.tools.length) {
    return message;
  }

  return {
    ...message,
    result: {
      ...result,
      tools: filteredTools
    }
  };
}

function isToolsListResponse(
  message: JSONRPCMessage
): message is JSONRPCMessage & { result: ToolsListLikeResult } {
  if (typeof message !== "object" || message === null || !("result" in message)) {
    return false;
  }

  const result = (message as { result?: unknown }).result;

  return (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { tools?: unknown }).tools)
  );
}
