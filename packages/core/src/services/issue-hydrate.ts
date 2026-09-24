import { asc, eq, inArray } from "drizzle-orm";

import type { ServiceContext } from "../context.js";
import { actors, issueDependencies, issues, workflowStates, type Issue, type Label } from "../db/schema.js";
import { issueReference, type IssueReference } from "./issue-reference.js";
import { listLabelsForIssues } from "./label.js";

// Internal to core (not exported from the barrel). Projects the relation and readable
// fields a page caller asked for onto a page of issues, loading ONLY those fields and
// using one batched query per requested field (bounded by the page size). Comments and
// attachments are never loaded: they are full-fidelity only via getIssue.

export type HydratableIssueField =
  | "labels" | "parent" | "children" | "blockedBy" | "blocks"
  | "stateName" | "stateType" | "assigneeHandle";

export type HydratedIssue = Issue & {
  labels?: Label[];
  parent?: IssueReference | null;
  children?: IssueReference[];
  blockedBy?: IssueReference[];
  blocks?: IssueReference[];
  stateName?: string;
  stateType?: string;
  assigneeHandle?: string | null;
};

const referenceColumns = {
  id: issues.id,
  identifier: issues.identifier,
  teamId: issues.teamId,
  number: issues.number,
  title: issues.title
};
const referenceOrder = [asc(issues.teamId), asc(issues.number), asc(issues.id)];

export function hydrateIssuePageRows(
  context: ServiceContext,
  page: readonly Issue[],
  fields: readonly string[] = []
): HydratedIssue[] {
  const requested = new Set(fields);
  const rows: HydratedIssue[] = page.map((issue) => ({ ...issue }));
  if (rows.length === 0 || requested.size === 0) return rows;

  const ids = rows.map((issue) => issue.id);

  if (requested.has("labels")) {
    const byIssue = listLabelsForIssues(context, ids);
    for (const row of rows) row.labels = byIssue.get(row.id) ?? [];
  }

  if (requested.has("parent")) {
    const parentIds = distinct(rows.map((row) => row.parentId));
    const parents = new Map(
      (parentIds.length
        ? context.db.select(referenceColumns).from(issues).where(inArray(issues.id, parentIds)).all()
        : []
      ).map((parent) => [parent.id, issueReference(parent)])
    );
    for (const row of rows) row.parent = row.parentId ? parents.get(row.parentId) ?? null : null;
  }

  if (requested.has("children")) {
    const byParent = groupBy(ids, context.db
      .select({ key: issues.parentId, ref: referenceColumns })
      .from(issues)
      .where(inArray(issues.parentId, ids))
      .orderBy(...referenceOrder)
      .all());
    for (const row of rows) row.children = byParent.get(row.id) ?? [];
  }

  if (requested.has("blockedBy")) {
    const byBlocked = groupBy(ids, context.db
      .select({ key: issueDependencies.blockedIssueId, ref: referenceColumns })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.blockingIssueId))
      .where(inArray(issueDependencies.blockedIssueId, ids))
      .orderBy(...referenceOrder)
      .all());
    for (const row of rows) row.blockedBy = byBlocked.get(row.id) ?? [];
  }

  if (requested.has("blocks")) {
    const byBlocking = groupBy(ids, context.db
      .select({ key: issueDependencies.blockingIssueId, ref: referenceColumns })
      .from(issueDependencies)
      .innerJoin(issues, eq(issues.id, issueDependencies.blockedIssueId))
      .where(inArray(issueDependencies.blockingIssueId, ids))
      .orderBy(...referenceOrder)
      .all());
    for (const row of rows) row.blocks = byBlocking.get(row.id) ?? [];
  }

  if (requested.has("stateName") || requested.has("stateType")) {
    const stateIds = distinct(rows.map((row) => row.stateId));
    const states = new Map(context.db
      .select({ id: workflowStates.id, name: workflowStates.name, type: workflowStates.type })
      .from(workflowStates)
      .where(inArray(workflowStates.id, stateIds))
      .all()
      .map((state) => [state.id, state]));
    for (const row of rows) {
      // issues.state_id is a foreign key, so every page row's state exists.
      const state = states.get(row.stateId)!;
      if (requested.has("stateName")) row.stateName = state.name;
      if (requested.has("stateType")) row.stateType = state.type;
    }
  }

  if (requested.has("assigneeHandle")) {
    const assigneeIds = distinct(rows.map((row) => row.assigneeId));
    const handles = new Map(
      (assigneeIds.length
        ? context.db.select({ id: actors.id, handle: actors.handle }).from(actors).where(inArray(actors.id, assigneeIds)).all()
        : []
      ).map((actor) => [actor.id, actor.handle])
    );
    for (const row of rows) row.assigneeHandle = row.assigneeId ? handles.get(row.assigneeId) ?? null : null;
  }

  return rows;
}

function distinct(values: ReadonlyArray<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function groupBy(
  ids: readonly string[],
  rows: ReadonlyArray<{ key: string | null; ref: Parameters<typeof issueReference>[0] }>
): Map<string, IssueReference[]> {
  const grouped = new Map<string, IssueReference[]>(ids.map((id) => [id, []]));
  for (const row of rows) if (row.key !== null) grouped.get(row.key)?.push(issueReference(row.ref));
  return grouped;
}
