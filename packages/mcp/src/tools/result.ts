import { AppErrorCode, errorEnvelope, toolContract } from "@issue-tracker/core";

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

/**
 * Registration fields owned by the core tool contract: the title, behavior annotations and, for
 * structured tools only, the advertised outputSchema.
 */
export function toolConfig(name: string) {
  const contract = toolContract(name);
  return {
    title: contract.annotations.title,
    annotations: contract.annotations,
    ...(contract.outputSchema ? { outputSchema: contract.outputSchema } : {})
  };
}

/**
 * A tool's success result. The text block is always the compact JSON (byte-identical to
 * jsonResult) so text-only clients keep working. Structured tools additionally carry the same
 * value as structuredContent, which the SDK validates against the advertised outputSchema.
 * Errors never go through here: they stay text-only (see jsonErrorResult).
 */
export function toolResult(name: string, value: unknown) {
  const result = jsonResult(value);
  if (!toolContract(name).structured) return result;
  return { ...result, structuredContent: JSON.parse(result.content[0].text) as Record<string, unknown> };
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

/**
 * Opens a per-call context. With `tool`, the caller's actor is provisioned only for tools that
 * are not read-only: a read resolves an existing actor (or none) and never writes.
 */
export function withMcpContext<T>(
  options: OpenMcpContextOptions & { tool?: string },
  work: (mcp: ReturnType<typeof openMcpContext>) => T
): T {
  const { tool, ...contextOptions } = options;
  const mcp = openMcpContext(
    tool === undefined
      ? contextOptions
      : { ...contextOptions, provisionActor: !toolContract(tool).annotations.readOnlyHint }
  );

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
