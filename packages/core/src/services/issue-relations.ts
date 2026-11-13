import { asc, eq, inArray } from "drizzle-orm";

import type { ServiceContext } from "../context.js";
import { issueRelations, issues } from "../db/schema.js";
import { issueReference, type IssueReference } from "./issue-reference.js";

// Non-hierarchical, non-blocking issue links. `follow_up` rows read "target is a follow-up
// of source"; `related` rows are symmetric and stored once with source < target. Nothing here
// feeds ready filtering, blockers, children, or progress counts.

export interface IssueRelationReferences {
  related: IssueReference[];
  followUpOf: IssueReference[];
  followUps: IssueReference[];
}

const referenceColumns = {
  id: issues.id,
  identifier: issues.identifier,
  teamId: issues.teamId,
  number: issues.number,
  title: issues.title
};
const referenceOrder = [asc(issues.teamId), asc(issues.number), asc(issues.id)];

function compareReferences(a: IssueReference, b: IssueReference): number {
  if (a.teamId !== b.teamId) return a.teamId < b.teamId ? -1 : 1;
  if (a.number !== b.number) return a.number - b.number;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Batched relation references for a bounded set of issue ids (one query per direction). */
export function listIssueRelationReferences(
  context: ServiceContext,
  issueIds: readonly string[]
): Map<string, IssueRelationReferences> {
  const result = new Map<string, IssueRelationReferences>(
    issueIds.map((id) => [id, { related: [], followUpOf: [], followUps: [] }])
  );
  if (issueIds.length === 0) return result;
  const ids = [...issueIds];

  const asSource = context.db
    .select({ kind: issueRelations.kind, key: issueRelations.sourceIssueId, ref: referenceColumns })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.targetIssueId))
    .where(inArray(issueRelations.sourceIssueId, ids))
    .orderBy(...referenceOrder)
    .all();
  const asTarget = context.db
    .select({ kind: issueRelations.kind, key: issueRelations.targetIssueId, ref: referenceColumns })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.sourceIssueId))
    .where(inArray(issueRelations.targetIssueId, ids))
    .orderBy(...referenceOrder)
    .all();

  for (const row of asSource) {
    const entry = result.get(row.key)!;
    (row.kind === "related" ? entry.related : entry.followUps).push(issueReference(row.ref));
  }
  for (const row of asTarget) {
    const entry = result.get(row.key)!;
    (row.kind === "related" ? entry.related : entry.followUpOf).push(issueReference(row.ref));
  }
  for (const entry of result.values()) entry.related.sort(compareReferences);

  return result;
}

export function getIssueRelationReferences(context: ServiceContext, issueId: string): IssueRelationReferences {
  return listIssueRelationReferences(context, [issueId]).get(issueId)!;
}

export function hasIssueRelations(refs: IssueRelationReferences): boolean {
  return refs.related.length > 0 || refs.followUpOf.length > 0 || refs.followUps.length > 0;
}
