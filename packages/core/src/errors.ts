export const AppErrorCode = {
  ISSUE_NOT_FOUND: "ISSUE_NOT_FOUND",
  TEAM_NOT_FOUND: "TEAM_NOT_FOUND",
  TEAM_KEY_TAKEN: "TEAM_KEY_TAKEN",
  ACTOR_NOT_FOUND: "ACTOR_NOT_FOUND",
  ACTOR_HANDLE_TAKEN: "ACTOR_HANDLE_TAKEN",
  WORKFLOW_STATE_NOT_FOUND: "WORKFLOW_STATE_NOT_FOUND",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  CYCLE_NOT_FOUND: "CYCLE_NOT_FOUND",
  LABEL_NOT_FOUND: "LABEL_NOT_FOUND",
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
