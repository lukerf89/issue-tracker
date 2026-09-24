import { AppError, AppErrorCode, errorEnvelope, toolContract, type ToolName } from "@issue-tracker/core";

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
export function toolConfig(name: ToolName) {
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
 * value as structuredContent, checked against the advertised outputSchema here so a mismatch is
 * reported as TOOL_CONTRACT_VIOLATION naming the tool (the SDK's own check runs after the handler
 * and would otherwise surface as an unclassified failure). Errors never go through here: they stay
 * text-only (see jsonErrorResult).
 */
export function toolResult(name: ToolName, value: unknown) {
  const result = jsonResult(value);
  const contract = toolContract(name);
  if (!contract.structured) return result;
  const structuredContent = JSON.parse(result.content[0].text) as Record<string, unknown>;
  const parsed = contract.outputSchema!.safeParse(structuredContent);
  if (!parsed.success) {
    throw new AppError(
      AppErrorCode.TOOL_CONTRACT_VIOLATION,
      `The ${name} result does not match its advertised output schema.`,
      { tool: name, mayHaveBeenApplied: !contract.annotations.readOnlyHint, issues: parsed.error.issues }
    );
  }
  return { ...result, structuredContent };
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
  options: OpenMcpContextOptions & { tool?: ToolName },
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

  if (typeof error === "string" && error.startsWith("MCP error -32602: Output validation error")) {
    // The SDK validates structuredContent after the handler returned, so a write has already
    // committed: never report this as a failed (retryable) database operation.
    return {
      error: {
        code: AppErrorCode.TOOL_CONTRACT_VIOLATION,
        message: "The tool result does not match its advertised output schema; the operation may have been applied.",
        details: { mayHaveBeenApplied: true, message: error }
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
