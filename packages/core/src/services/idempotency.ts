import { AppError, AppErrorCode } from "../errors.js";

// Shared retry-key helpers for comment and attachment writes. services/issue.ts keeps its own
// private copies of the normalization and unique-violation matcher for now (same semantics).

// A blank/whitespace-only key must never act as a dedupe token (it would collide across
// unrelated writes), so it collapses to null == "no key". No case folding.
export function normalizeIdempotencyKey(key: string | null | undefined): string | null {
  if (key === null || key === undefined) {
    return null;
  }
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// better-sqlite3 surfaces a UNIQUE violation as a SqliteError with a SQLITE_CONSTRAINT_UNIQUE
// code; match on the key column so unrelated constraint errors are never swallowed.
export function isIdempotencyUniqueViolation(error: unknown, column: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT") &&
    typeof message === "string" &&
    message.includes(column)
  );
}

// Differing fields, reported in the caller's fixed declared order (never sorted), so error
// details are deterministic.
export function mismatchedFields<T extends Record<string, unknown>>(
  expected: T,
  actual: T,
  orderedFields: readonly (keyof T & string)[]
): string[] {
  return orderedFields.filter((field) => expected[field] !== actual[field]);
}

export interface IdempotencyConflictDetails {
  resource: "comment" | "attachment";
  idempotencyKey: string;
  existingId: string;
  issueIdentifier: string;
  mismatchedFields: string[];
}

export function idempotencyConflict(details: IdempotencyConflictDetails): AppError {
  return new AppError(
    AppErrorCode.IDEMPOTENCY_KEY_CONFLICT,
    `Idempotency key ${details.idempotencyKey} was already used for ${details.resource} ` +
      `${details.existingId} on ${details.issueIdentifier} with a different payload ` +
      `(${details.mismatchedFields.join(", ")}).`,
    details
  );
}
