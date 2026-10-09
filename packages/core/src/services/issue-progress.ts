import { and, asc, count, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
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
    const activeChild = and(eq(issues.parentId, issue.id), isNull(issues.archivedAt));
    const inFamily = or(eq(issues.id, issue.id), activeChild);
    const groupedStates = tx.db.select({ state: workflowStates.name, total: count() }).from(issues)
      .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
      .where(activeChild).groupBy(workflowStates.name).all();
    const counts = Object.fromEntries(groupedStates.map((row) => [row.state, row.total]).sort(([a], [b]) => String(a).localeCompare(String(b))));
    const childCount = groupedStates.reduce((total, row) => total + row.total, 0);
    const remainingCriteria = tx.db.select({ total: count() }).from(issueCriteria)
      .innerJoin(issues, eq(issues.id, issueCriteria.issueId))
      .where(and(inFamily, isNull(issueCriteria.archivedAt), inArray(issueCriteria.status, ["pending", "failed"]))).get()?.total ?? 0;
    const structuredBlockers = tx.db.select({ total: count() }).from(issueBlockers)
      .innerJoin(issues, eq(issues.id, issueBlockers.issueId))
      .where(and(inFamily, isNull(issueBlockers.resolvedAt))).get()?.total ?? 0;
    const blocking = alias(issues, "blocking_issue");
    const blockingState = alias(workflowStates, "blocking_state");
    const dependencyBlockers = tx.db.select({ total: count() }).from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.blockedIssueId))
      .innerJoin(blocking, eq(blocking.id, issueDependencies.blockingIssueId))
      .innerJoin(blockingState, eq(blockingState.id, blocking.stateId))
      .where(and(inFamily, isNull(blocking.archivedAt), notInArray(blockingState.type, ["completed", "canceled"]))).get()?.total ?? 0;
    const unresolvedBlockers = structuredBlockers + dependencyBlockers;
    const children = tx.db.select({ id: issues.id, identifier: issues.identifier, revision: issues.revision, state: workflowStates.name })
      .from(issues).innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
      .where(activeChild)
      .orderBy(asc(issues.teamId), asc(issues.number), asc(issues.id))
      .limit(parsed.childLimit).offset(parsed.childOffset).all();
    const page = children.map((child) => {
      const progress = progressFor(tx, child.id);
      const remaining = progress.criteria.filter((row) => row.status === "pending" || row.status === "failed").length;
      const blocked = progress.blockers.filter((row) => row.resolvedAt === null).length + progress.dependencyBlockers.length;
      return { identifier: child.identifier, state: child.state, revision: child.revision, remainingCriteria: remaining, unresolvedBlockers: blocked, links: deliveryLinks(tx, child.id) };
    });
    const links = deliveryLinks(tx, issue.id);
    const state = tx.db.query.workflowStates.findFirst({ where: eq(workflowStates.id, issue.stateId) }).sync();
    return {
      identifier: issue.identifier, state: state?.name ?? issue.stateId, revision: issue.revision,
      criteria: own.criteria.map((row) => ({ id: row.id, text: row.text, status: row.status, evidenceUrl: row.evidenceUrl })),
      blockers: own.blockers.map((row) => ({ id: row.id, kind: row.kind, description: row.description, unblockAction: row.unblockAction, owner: row.owner, resolvedAt: row.resolvedAt })),
      dependencyBlockers: own.dependencyBlockers,
      children: page, childCount, nextChildOffset: parsed.childOffset + page.length < childCount ? parsed.childOffset + page.length : null,
      statusCounts: counts,
      remainingCriteria, unresolvedBlockers, links
    };
  });
}
