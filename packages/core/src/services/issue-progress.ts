import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { inTransaction, type ServiceContext } from "../context.js";
import { attachments, issueBlockers, issueCriteria, issueDependencies, issues, workflowStates } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { getIssueProgressInputSchema, updateIssueProgressInputSchema, type GetIssueProgressInput, type UpdateIssueProgressInput } from "../schemas/issue-progress.js";
import { appendActivityInTransaction } from "./activity.js";
import { assertIssueRevision } from "./issue-revision.js";

type Operation = ReturnType<typeof updateIssueProgressInputSchema.parse>["operations"][number];

function issueRow(context: ServiceContext, identifier: string) {
  const issue = context.db.query.issues.findFirst({ where: eq(issues.identifier, identifier) }).sync();
  if (!issue) throw new AppError(AppErrorCode.ISSUE_NOT_FOUND, `Issue ${identifier} was not found.`, { identifier });
  return issue;
}

function applyOperation(context: ServiceContext, issueId: string, operation: Operation, now: string): string | null {
  if (operation.type === "criterion") {
    if (operation.action === "add") {
      const id = uuid();
      context.db.insert(issueCriteria).values({ id, issueId, text: operation.text, status: operation.status, evidenceUrl: operation.evidenceUrl ?? null, createdAt: now, updatedAt: now, archivedAt: null }).run();
      return id;
    }
    const row = context.db.query.issueCriteria.findFirst({ where: and(eq(issueCriteria.id, operation.id), eq(issueCriteria.issueId, issueId)) }).sync();
    if (!row) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Criterion does not belong to this issue.", { id: operation.id });
    const changes = {
      text: operation.text ?? row.text,
      status: operation.status ?? row.status,
      evidenceUrl: operation.evidenceUrl === undefined ? row.evidenceUrl : operation.evidenceUrl,
      archivedAt: operation.archived === undefined ? row.archivedAt : operation.archived ? row.archivedAt ?? now : null
    };
    if (Object.entries(changes).every(([key, value]) => row[key as keyof typeof changes] === value)) return null;
    context.db.update(issueCriteria).set({ ...changes, updatedAt: now }).where(eq(issueCriteria.id, row.id)).run();
    return row.id;
  }
  if (operation.action === "add") {
    const id = uuid();
    context.db.insert(issueBlockers).values({ id, issueId, kind: operation.kind, description: operation.description, unblockAction: operation.unblockAction, owner: operation.owner, createdAt: now, updatedAt: now, resolvedAt: null }).run();
    return id;
  }
  const row = context.db.query.issueBlockers.findFirst({ where: and(eq(issueBlockers.id, operation.id), eq(issueBlockers.issueId, issueId)) }).sync();
  if (!row) throw new AppError(AppErrorCode.VALIDATION_FAILED, "Blocker does not belong to this issue.", { id: operation.id });
  const changes = {
    kind: operation.kind ?? row.kind,
    description: operation.description ?? row.description,
    unblockAction: operation.unblockAction ?? row.unblockAction,
    owner: operation.owner ?? row.owner,
    resolvedAt: operation.resolved === undefined ? row.resolvedAt : operation.resolved ? row.resolvedAt ?? now : null
  };
  if (Object.entries(changes).every(([key, value]) => row[key as keyof typeof changes] === value)) return null;
  context.db.update(issueBlockers).set({ ...changes, updatedAt: now }).where(eq(issueBlockers.id, row.id)).run();
  return row.id;
}

export function updateIssueProgress(context: ServiceContext, input: UpdateIssueProgressInput) {
  const parsed = updateIssueProgressInputSchema.parse(input);
  if (!context.actor) throw new AppError(AppErrorCode.VALIDATION_FAILED, "An actor is required to update progress.");
  return inTransaction(context, (tx) => {
    assertIssueRevision(tx, parsed.identifier, parsed.expectedRevision);
    const issue = issueRow(tx, parsed.identifier);
    const now = tx.clock.now().toISOString();
    const changes: Array<{ type: "criterion" | "blocker"; id: string }> = [];
    for (const operation of parsed.operations) {
      const id = applyOperation(tx, issue.id, operation, now);
      if (id) changes.push({ type: operation.type, id });
    }
    if (changes.length) {
      tx.db.update(issues).set({ updatedAt: now }).where(eq(issues.id, issue.id)).run();
      appendActivityInTransaction(tx, { issueId: issue.id, actorId: context.actor!.id, action: "progress_updated", data: { changes } });
    }
    const current = issueRow(tx, parsed.identifier);
    return { identifier: current.identifier, revision: current.revision, changes };
  });
}

function progressFor(context: ServiceContext, issueId: string) {
  const criteria = context.db.query.issueCriteria.findMany({ where: and(eq(issueCriteria.issueId, issueId), isNull(issueCriteria.archivedAt)), orderBy: [asc(issueCriteria.createdAt), asc(issueCriteria.id)] }).sync();
  const blockers = context.db.query.issueBlockers.findMany({ where: eq(issueBlockers.issueId, issueId), orderBy: [asc(issueBlockers.createdAt), asc(issueBlockers.id)] }).sync();
  const dependencyBlockers = context.db.select({ identifier: issues.identifier, type: workflowStates.type, archivedAt: issues.archivedAt })
    .from(issueDependencies).innerJoin(issues, eq(issues.id, issueDependencies.blockingIssueId))
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .where(eq(issueDependencies.blockedIssueId, issueId)).orderBy(asc(issues.identifier)).all()
    .filter((row) => row.archivedAt === null && row.type !== "completed" && row.type !== "canceled")
    .map((row) => row.identifier);
  return { criteria, blockers, dependencyBlockers };
}

function deliveryLinks(context: ServiceContext, issueId: string) {
  return context.db.query.attachments.findMany({ where: and(eq(attachments.issueId, issueId), inArray(attachments.kind, ["branch", "commit", "pr"])), orderBy: [asc(attachments.createdAt), asc(attachments.id)] }).sync().map((row) => ({ kind: row.kind, title: row.title, url: row.url, branchName: row.branchName, commitSha: row.commitSha }));
}

export function getIssueProgress(context: ServiceContext, input: GetIssueProgressInput) {
  const parsed = getIssueProgressInputSchema.parse(input);
  return context.db.transaction((db) => {
    const tx = { ...context, db };
    const issue = issueRow(tx, parsed.identifier);
    const own = progressFor(tx, issue.id);
    const children = tx.db.query.issues.findMany({ where: eq(issues.parentId, issue.id), orderBy: [asc(issues.teamId), asc(issues.number), asc(issues.id)] }).sync();
    const states = tx.db.query.workflowStates.findMany({ where: inArray(workflowStates.id, [issue, ...children].map((row) => row.stateId)) }).sync();
    const names = new Map(states.map((state) => [state.id, state.name]));
    const counts: Record<string, number> = {};
    let remainingCriteria = own.criteria.filter((row) => row.status === "pending" || row.status === "failed").length;
    let unresolvedBlockers = own.blockers.filter((row) => row.resolvedAt === null).length + own.dependencyBlockers.length;
    const summaries = children.map((child) => {
      const progress = progressFor(tx, child.id);
      const state = names.get(child.stateId) ?? child.stateId;
      counts[state] = (counts[state] ?? 0) + 1;
      const remaining = progress.criteria.filter((row) => row.status === "pending" || row.status === "failed").length;
      const blocked = progress.blockers.filter((row) => row.resolvedAt === null).length + progress.dependencyBlockers.length;
      remainingCriteria += remaining;
      unresolvedBlockers += blocked;
      return { id: child.id, identifier: child.identifier, state, revision: child.revision, remainingCriteria: remaining, unresolvedBlockers: blocked };
    });
    const links = deliveryLinks(tx, issue.id);
    const page = summaries.slice(parsed.childOffset, parsed.childOffset + parsed.childLimit).map(({ id, ...summary }) => ({ ...summary, links: deliveryLinks(tx, id) }));
    return {
      identifier: issue.identifier, state: names.get(issue.stateId) ?? issue.stateId, revision: issue.revision,
      criteria: own.criteria.map((row) => ({ id: row.id, text: row.text, status: row.status, evidenceUrl: row.evidenceUrl })),
      blockers: own.blockers.map((row) => ({ id: row.id, kind: row.kind, description: row.description, unblockAction: row.unblockAction, owner: row.owner, resolvedAt: row.resolvedAt })),
      dependencyBlockers: own.dependencyBlockers,
      children: page, childCount: children.length, nextChildOffset: parsed.childOffset + page.length < summaries.length ? parsed.childOffset + page.length : null,
      statusCounts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      remainingCriteria, unresolvedBlockers, links
    };
  });
}
