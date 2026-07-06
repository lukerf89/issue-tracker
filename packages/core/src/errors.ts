import { inspect } from "node:util";

export const AppErrorCode = {
  ISSUE_NOT_FOUND: "ISSUE_NOT_FOUND",
  ISSUE_PARENT_CYCLE: "ISSUE_PARENT_CYCLE",
  TEAM_NOT_FOUND: "TEAM_NOT_FOUND",
  TEAM_KEY_TAKEN: "TEAM_KEY_TAKEN",
  ACTOR_NOT_FOUND: "ACTOR_NOT_FOUND",
  ACTOR_HANDLE_TAKEN: "ACTOR_HANDLE_TAKEN",
  WORKFLOW_STATE_NOT_FOUND: "WORKFLOW_STATE_NOT_FOUND",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  CYCLE_NOT_FOUND: "CYCLE_NOT_FOUND",
  LABEL_NOT_FOUND: "LABEL_NOT_FOUND",
  COMMENT_NOT_FOUND: "COMMENT_NOT_FOUND",
  ALREADY_INITIALIZED: "ALREADY_INITIALIZED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  CONSTRAINT_VIOLATION: "CONSTRAINT_VIOLATION",
  DATABASE_ERROR: "DATABASE_ERROR"
} as const;

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode];

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export interface ErrorEnvelope {
  error: {
    code: AppErrorCode;
    message: string;
    details?: unknown;
  };
}

export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }

  if (isZodError(error)) {
    return {
      error: {
        code: AppErrorCode.VALIDATION_FAILED,
        message: "Input validation failed.",
        details: { issues: error.issues }
      }
    };
  }

  return {
    error: {
      code: AppErrorCode.DATABASE_ERROR,
      message: error instanceof Error ? error.message : inspect(error)
    }
  };
}

function isZodError(error: unknown): error is { issues: unknown[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ZodError" &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}
