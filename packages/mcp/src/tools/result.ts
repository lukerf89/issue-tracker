import { AppErrorCode, errorEnvelope } from "@issue-tracker/core";

import { openMcpContext, type OpenMcpContextOptions } from "../context.js";

export function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value)
      }
    ]
  };
}

export function jsonErrorResult(error: unknown) {
  return {
    ...jsonResult(mcpErrorEnvelope(error)),
    isError: true as const
  };
}

export function mcpToolResult<T>(work: () => T): T | ReturnType<typeof jsonErrorResult> {
  try {
    return work();
  } catch (error) {
    return jsonErrorResult(error);
  }
}

export function withMcpContext<T>(
  options: OpenMcpContextOptions,
  work: (mcp: ReturnType<typeof openMcpContext>) => T
): T {
  const mcp = openMcpContext(options);

  try {
    return work(mcp);
  } finally {
    mcp.close();
  }
}

function mcpErrorEnvelope(error: unknown) {
  if (typeof error === "string" && error.startsWith("MCP error -32602: Input validation error")) {
    return {
      error: {
        code: AppErrorCode.VALIDATION_FAILED,
        message: "Input validation failed.",
        details: sdkValidationDetails(error)
      }
    };
  }

  return errorEnvelope(error);
}

function sdkValidationDetails(message: string) {
  const jsonStart = message.indexOf("[");

  if (jsonStart !== -1) {
    try {
      const issues = JSON.parse(message.slice(jsonStart));

      if (Array.isArray(issues)) {
        return { issues };
      }
    } catch {
      // Fall back to the SDK message below when the diagnostic is not JSON.
    }
  }

  return { message };
}
