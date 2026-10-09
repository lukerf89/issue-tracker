import { inTransaction, type ServiceContext } from "../context.js";
import { AppError, AppErrorCode, errorEnvelope } from "../errors.js";
import { batchMoveIssuesInputSchema, type BatchMoveIssuesInput } from "../schemas/issue-batch.js";
import { getState } from "./state.js";
import { moveIssue } from "./issue.js";

/** One outer transaction. Continue mode uses a nested savepoint for every issue. */
export function batchMoveIssues(context: ServiceContext, input: BatchMoveIssuesInput) {
  const parsed = batchMoveIssuesInputSchema.parse(input);
  return inTransaction(context, (tx) => {
    const results: Array<{ identifier: string; from: string | null; to: string | null; revision: number | null; error: ReturnType<typeof errorEnvelope>["error"] | null }> = [];
    for (const move of parsed.moves) {
      try {
        const changed = inTransaction(tx, (itemTx) => {
          const before = itemTx.db.query.issues.findFirst({ where: (table, { eq }) => eq(table.identifier, move.identifier) }).sync();
          if (!before) throw new AppError(AppErrorCode.ISSUE_NOT_FOUND, `Issue ${move.identifier} was not found.`, { identifier: move.identifier });
          const from = getState(itemTx, before.stateId, before.teamId).name;
          const after = moveIssue(itemTx, move.identifier, move.state, { expectedRevision: move.expectedRevision });
          const to = getState(itemTx, after.stateId, after.teamId).name;
          return { identifier: after.identifier, from, to, revision: after.revision, error: null };
        });
        results.push(changed);
      } catch (error) {
        const failure = { identifier: move.identifier, from: null, to: null, revision: null, error: errorEnvelope(error).error };
        if (parsed.onError === "rollback") {
          throw new AppError(AppErrorCode.VALIDATION_FAILED, "Batch rolled back after an issue failed.", { failed: failure, appliedBeforeRollback: results.map((item) => item.identifier) });
        }
        results.push(failure);
      }
    }
    return { applied: results.filter((result) => result.error === null).length, failed: results.filter((result) => result.error !== null).length, results };
  });
}
