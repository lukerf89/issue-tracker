import { relative, resolve } from "node:path";

import { eq } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { runActions } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { appendRunEventInTransaction, getRun } from "./run.js";

export function requestRunCleanup(context: ServiceContext, input: { run: string; kind: "worktree" | "raw_logs"; managedRoot: string; confirmed: boolean; allowUnmerged?: boolean }) {
  if (!input.confirmed) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "Cleanup requires explicit confirmation.");
  return inTransaction(context, (txContext) => {
    const run = getRun(txContext, input.run);
    if (!run.completedAt) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "Cleanup cannot remove artifacts from an active run.");
    const paths = input.kind === "worktree" ? run.repositories.map((repository) => repository.worktreePath) : run.artifacts.filter((artifact) => artifact.kind === "raw_log" && artifact.localPath && !artifact.removedAt).map((artifact) => artifact.localPath!);
    for (const path of paths) assertContained(input.managedRoot, path);
    if (input.kind === "worktree" && !input.allowUnmerged) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "Unmerged worktrees are preserved by default; pass explicit allowUnmerged after verifying recovery artifacts.");
    const now = txContext.clock.now().toISOString();
    const action = { id: uuid(), runId: run.id, attemptId: null, kind: input.kind === "worktree" ? "remove_worktree" : "remove_raw_logs", idempotencyKey: `${run.id}:cleanup:${input.kind}`, payload: { paths, artifactIds: run.artifacts.filter((artifact) => paths.includes(artifact.localPath ?? "")).map((artifact) => artifact.id), allowUnmerged: input.allowUnmerged ?? false }, state: "queued" as const, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null };
    txContext.db.insert(runActions).values(action).onConflictDoNothing().run();
    appendRunEventInTransaction(txContext, { runId: run.id, type: "cleanup.requested", data: { kind: input.kind, paths } });
    return txContext.db.query.runActions.findFirst({ where: eq(runActions.idempotencyKey, action.idempotencyKey) }).sync()!;
  });
}

export function assertContained(managedRoot: string, path: string) {
  const root = resolve(managedRoot);
  const target = resolve(path);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || relation.startsWith("/")) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Cleanup target ${target} is outside or equal to managed root ${root}.`, { root, target });
}
