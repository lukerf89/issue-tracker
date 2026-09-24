import { desc, eq } from "drizzle-orm";

import type { ServiceContext } from "../context.js";
import { actors, agentRuns, comments, issueDependencies, issues, workflowStates, type Issue } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import {
  getWorkContextInputSchema, workContextResponseSchema, workContextSchema, WORK_CONTEXT_DEFAULT_MAX_BYTES, WORK_CONTEXT_MAX_CHANGES,
  type GetWorkContextInput, type WorkContext, type WorkContextChange, type WorkContextResponse, type WorkContextRoutingEntry, type WorkContextStaleness
} from "../schemas/work-context.js";
import { fitStringPrefix, jsonBytes } from "./json-budget.js";
import { repositoryRoutingForIssue, repositoryRoutingStatus, type RepositoryRoutingCandidate, type RepositoryRoutingSource } from "./repository.js";
import { stableHash, stableStringify } from "./stable-hash.js";

/** Raised when even the mandatory minimum of a work context cannot fit the requested budget. */
export class WorkContextMinimumExceededError extends AppError {
  constructor(readonly identifier: string, readonly minimumBytes: number, readonly maxBytes: number) {
    super(AppErrorCode.VALIDATION_FAILED, "Work context minimum (acceptance criteria and source revisions) exceeds maxBytes; increase maxBytes.", { minimumBytes, maxBytes });
  }
}

/** Fixed budget of the work context frozen into a run snapshot at preview time. */
export const RUN_WORK_CONTEXT_MAX_BYTES = 16384;

// Deterministic selection limits (no summarizer). "limit" omissions are reported against these.
const DECISION_LIMIT = 10;
const RECENT_COMMENT_LIMIT = 5;
const COMMENT_BODY_LIMIT = 1000;
const PARENT_EXCERPT_LIMIT = 1000;
// Comments whose body starts with "Decision:" or "Decided:" (case-insensitive) are decisions.
const DECISION_PATTERN = /^\s*(?:decision|decided)\s*:/i;
const ACCEPTANCE_HEADING = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:done when|acceptance criteria)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const PLACEHOLDER_FINGERPRINT = "0".repeat(64);

type Section = WorkContext["omissions"][number]["section"];
type Retrieval = WorkContext["omissions"][number]["retrieval"];
type StateRef = { name: string; type: WorkContext["sections"]["task"]["state"]["type"] };
type CommentSource = { id: string; author: string | null; createdAt: string; body: string };

interface WorkSources {
  issue: Issue;
  state: StateRef;
  parent: { issue: Issue; state: StateRef } | null;
  blockers: Array<{ issue: Issue; state: StateRef; resolved: boolean }>;
  routing: { source: RepositoryRoutingSource; status: "resolved" | "ambiguous" | "missing"; primaryRepositoryId: string | null; candidates: RepositoryRoutingCandidate[] };
  decisions: CommentSource[];
  recentComments: CommentSource[];
  latestComment: CommentSource | null;
}

/** Parses "Done when" / "Acceptance criteria" list blocks from Markdown, ignoring fenced code. */
export function parseAcceptanceCriteria(markdown: string | null): { found: boolean; items: string[] } {
  const items: string[] = [];
  let found = false, inBlock = false, fence: string | null = null, lastWasItem = false;
  for (const line of (markdown ?? "").split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]!; inBlock = false; lastWasItem = false; continue; }
    if (ACCEPTANCE_HEADING.test(line)) { found = true; inBlock = true; lastWasItem = false; continue; }
    if (!inBlock) continue;
    if (line.trim() === "") continue;
    const item = LIST_ITEM.exec(line);
    if (item) { items.push(item[1]!); lastWasItem = true; continue; }
    if (lastWasItem && /^\s{2,}\S/.test(line)) { items[items.length - 1] += ` ${line.trim()}`; continue; }
    inBlock = false; lastWasItem = false;
  }
  return { found, items };
}

function compareIdentifiers(left: string, right: string): number {
  const a = /^(.*)-(\d+)$/.exec(left), b = /^(.*)-(\d+)$/.exec(right);
  if (a && b && a[1] === b[1]) return Number(a[2]) - Number(b[2]);
  return left < right ? -1 : left > right ? 1 : 0;
}

function excerpt(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, fitStringPrefix(text, 0, (slice) => slice.length <= limit)), truncated: true };
}

function stateOf(context: ServiceContext, stateId: string): StateRef {
  const state = context.db.query.workflowStates.findFirst({ where: eq(workflowStates.id, stateId) }).sync();
  if (!state) throw new AppError(AppErrorCode.DATA_INTEGRITY, `Workflow state ${stateId} was not found.`);
  return { name: state.name, type: state.type };
}

function loadSources(context: ServiceContext, identifier: string): WorkSources {
  const issue = context.db.query.issues.findFirst({ where: eq(issues.identifier, identifier) }).sync();
  if (!issue) throw new AppError(AppErrorCode.ISSUE_NOT_FOUND, `Issue ${identifier} was not found.`, { identifier });
  const parentRow = issue.parentId ? context.db.query.issues.findFirst({ where: eq(issues.id, issue.parentId) }).sync() ?? null : null;
  const blockers = context.db.select({ issue: issues, state: workflowStates }).from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.blockingIssueId))
    .innerJoin(workflowStates, eq(workflowStates.id, issues.stateId))
    .where(eq(issueDependencies.blockedIssueId, issue.id)).all()
    .map(({ issue: blocker, state }) => ({ issue: blocker, state: { name: state.name, type: state.type }, resolved: state.type === "completed" || state.type === "canceled" }))
    .sort((left, right) => Number(left.resolved) - Number(right.resolved) || compareIdentifiers(left.issue.identifier, right.issue.identifier));
  const history = context.db.select({ id: comments.id, author: actors.handle, createdAt: comments.createdAt, body: comments.body }).from(comments)
    .leftJoin(actors, eq(actors.id, comments.authorId))
    .where(eq(comments.issueId, issue.id)).orderBy(desc(comments.createdAt), desc(comments.id)).all();
  return {
    issue,
    state: stateOf(context, issue.stateId),
    parent: parentRow ? { issue: parentRow, state: stateOf(context, parentRow.stateId) } : null,
    blockers,
    routing: repositoryRoutingForIssue(context, issue),
    decisions: history.filter((comment) => DECISION_PATTERN.test(comment.body)),
    recentComments: history.filter((comment) => !DECISION_PATTERN.test(comment.body)),
    latestComment: history[0] ?? null
  };
}

function routingEntries(candidates: RepositoryRoutingCandidate[]): WorkContextRoutingEntry[] {
  return candidates.map((candidate) => ({ repositoryId: candidate.id, position: candidate.position, isDefault: candidate.isDefault, overrideKind: candidate.overrideKind, updatedAt: candidate.updatedAt }));
}

function sourceRevisionsOf(sources: WorkSources): WorkContext["sourceRevisions"] {
  const entries = routingEntries(sources.routing.candidates);
  return {
    issue: { identifier: sources.issue.identifier, revision: sources.issue.revision },
    parent: sources.parent ? { identifier: sources.parent.issue.identifier, revision: sources.parent.issue.revision } : null,
    blockers: sources.blockers.map(({ issue }) => ({ identifier: issue.identifier, revision: issue.revision })).sort((left, right) => compareIdentifiers(left.identifier, right.identifier)),
    comments: {
      count: sources.decisions.length + sources.recentComments.length,
      decisionCount: sources.decisions.length,
      latestCommentId: sources.latestComment?.id ?? null,
      latestCreatedAt: sources.latestComment?.createdAt ?? null
    },
    repositories: { routingFingerprint: stableHash({ source: sources.routing.source, entries }), source: sources.routing.source, entries }
  };
}

function retrievals(sources: WorkSources): Record<Section, Retrieval> {
  const id = sources.issue.identifier;
  const description = { mcp: { tool: "read_issue_section", args: { identifier: id, path: ["description"] } }, cli: `tracker issue read-section ${id} --path description --json` };
  const commentPath = { mcp: { tool: "read_issue_section", args: { identifier: id, path: ["comments"] } }, cli: `tracker issue read-section ${id} --path comments --json` };
  const parentId = sources.parent?.issue.identifier;
  return {
    task: description,
    acceptanceCriteria: description,
    blockers: { mcp: { tool: "get_issue", args: { identifier: id, fields: ["blockedBy"] } }, cli: `tracker issue view ${id} --fields blockedBy --json` },
    parent: parentId
      ? { mcp: { tool: "read_issue_section", args: { identifier: parentId, path: ["description"] } }, cli: `tracker issue read-section ${parentId} --path description --json` }
      : { mcp: { tool: "get_issue", args: { identifier: id, fields: ["parent"] } }, cli: `tracker issue view ${id} --fields parent --json` },
    repositories: { mcp: { tool: "get_work_context", args: { identifier: id, maxBytes: 65536 } }, cli: `tracker issue context ${id} --max-bytes 65536 --json` },
    decisions: commentPath,
    recentComments: commentPath
  };
}

interface Fill {
  descriptionEnd: number;
  blockers: number;
  parent: boolean;
  parentExcerptEnd: number;
  candidates: number;
  decisions: number;
  comments: number;
}

/**
 * Renders the context for a fill state, including the exact omission entries that state implies.
 * Every rendering is a complete, valid context: admitting more content only removes or shrinks
 * omission entries, so any fill state that was measured to fit can be returned as is.
 */
function render(sources: WorkSources, maxBytes: number, fill: Fill, usedBytes: number, contextFingerprint: string): WorkContext {
  const { issue } = sources;
  const retrieval = retrievals(sources);
  const description = issue.description;
  const descriptionTruncated = description !== null && fill.descriptionEnd < description.length;
  const parentDescription = sources.parent?.issue.description ?? null;
  const parentCap = parentDescription === null ? 0 : excerpt(parentDescription, PARENT_EXCERPT_LIMIT).text.length;
  const blockers = sources.blockers.slice(0, fill.blockers);
  const candidates = sources.routing.candidates.slice(0, fill.candidates);
  const decisions = sources.decisions.slice(0, fill.decisions);
  const recent = sources.recentComments.slice(0, fill.comments);
  const commentItem = (comment: CommentSource) => {
    const body = excerpt(comment.body, COMMENT_BODY_LIMIT);
    return { id: comment.id, author: comment.author, createdAt: comment.createdAt, body: body.text, bodyTruncated: body.truncated };
  };

  const omissions: WorkContext["omissions"] = [];
  const omit = (section: Section, reason: "budget" | "limit", unit: "items" | "characters", omittedCount: number) => { if (omittedCount > 0) omissions.push({ section, reason, unit, omittedCount, retrieval: retrieval[section] }); };
  if (descriptionTruncated) omit("task", "budget", "characters", description!.length - fill.descriptionEnd);
  omit("blockers", "budget", "items", sources.blockers.length - blockers.length);
  if (sources.parent && !fill.parent) omit("parent", "budget", "items", 1);
  else if (sources.parent && parentDescription !== null && fill.parentExcerptEnd < parentDescription.length) omit("parent", fill.parentExcerptEnd < parentCap ? "budget" : "limit", "characters", parentDescription.length - fill.parentExcerptEnd);
  omit("repositories", "budget", "items", sources.routing.candidates.length - candidates.length);
  omit("decisions", decisions.length < Math.min(DECISION_LIMIT, sources.decisions.length) ? "budget" : "limit", "items", sources.decisions.length - decisions.length);
  omit("recentComments", recent.length < Math.min(RECENT_COMMENT_LIMIT, sources.recentComments.length) ? "budget" : "limit", "items", sources.recentComments.length - recent.length);
  const truncated = (section: Section) => omissions.some((omission) => omission.section === section);
  const acceptance = parseAcceptanceCriteria(description);

  return {
    schemaVersion: 1,
    budget: { unit: "utf8_json_bytes", maxBytes, usedBytes },
    sourceRevisions: sourceRevisionsOf(sources),
    contextFingerprint,
    sections: {
      task: {
        provenance: { source: "issue", ids: [issue.id], revision: issue.revision }, retrieval: retrieval.task, truncated: truncated("task"),
        identifier: issue.identifier, title: issue.title, state: sources.state, priority: issue.priority, revision: issue.revision,
        description: description === null ? null : description.slice(0, fill.descriptionEnd)
      },
      acceptanceCriteria: {
        provenance: { source: "issue.description", ids: [issue.id], revision: issue.revision }, retrieval: retrieval.acceptanceCriteria, truncated: false,
        found: acceptance.found, items: acceptance.items
      },
      blockers: {
        provenance: { source: "issue_dependencies", ids: blockers.map((blocker) => blocker.issue.id), revision: issue.revision }, retrieval: retrieval.blockers, truncated: truncated("blockers"),
        total: sources.blockers.length, unresolvedCount: sources.blockers.filter((blocker) => !blocker.resolved).length,
        items: blockers.map((blocker) => ({ identifier: blocker.issue.identifier, title: blocker.issue.title, state: blocker.state, resolved: blocker.resolved, revision: blocker.issue.revision }))
      },
      parent: {
        provenance: { source: "parent_issue", ids: sources.parent && fill.parent ? [sources.parent.issue.id] : [], revision: sources.parent?.issue.revision ?? null }, retrieval: retrieval.parent, truncated: truncated("parent"),
        item: sources.parent && fill.parent ? {
          identifier: sources.parent.issue.identifier, title: sources.parent.issue.title, state: sources.parent.state, revision: sources.parent.issue.revision,
          descriptionExcerpt: parentDescription === null ? null : parentDescription.slice(0, fill.parentExcerptEnd),
          descriptionTruncated: parentDescription !== null && fill.parentExcerptEnd < parentDescription.length
        } : null
      },
      repositories: {
        provenance: { source: "repository_routing", ids: candidates.map((candidate) => candidate.id), revision: null }, retrieval: retrieval.repositories, truncated: truncated("repositories"),
        status: sources.routing.status, source: sources.routing.source, primaryRepositoryId: sources.routing.primaryRepositoryId, total: sources.routing.candidates.length,
        candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, defaultBranch: candidate.defaultBranch, position: candidate.position, isDefault: candidate.isDefault, overrideKind: candidate.overrideKind, primary: candidate.primary }))
      },
      decisions: {
        provenance: { source: "comments", ids: decisions.map((comment) => comment.id), revision: issue.revision }, retrieval: retrieval.decisions, truncated: truncated("decisions"),
        total: sources.decisions.length, items: decisions.map(commentItem)
      },
      recentComments: {
        provenance: { source: "comments", ids: recent.map((comment) => comment.id), revision: issue.revision }, retrieval: retrieval.recentComments, truncated: truncated("recentComments"),
        total: sources.recentComments.length, items: recent.map(commentItem)
      }
    },
    omissions
  };
}

function fingerprintOf(context: WorkContext): string {
  // The fingerprint covers everything except itself and usedBytes (a function of the rest).
  return stableHash({ ...context, contextFingerprint: null, budget: { unit: context.budget.unit, maxBytes: context.budget.maxBytes } });
}

/**
 * Builds the bounded work context on an already-open transaction context (the caller owns the
 * transaction). Clock-free and deterministic: identical source state yields byte-identical output.
 * The mandatory minimum (task scalars, full acceptance criteria, source revisions, routing header,
 * and an omission entry for every optional section) is sized first; only if it cannot fit does the
 * build fail. Remaining bytes are spent in fixed priority order: description, blockers, parent,
 * repository candidates, decisions, recent comments. Each admission is measured on the complete
 * context it would produce, so acceptance criteria can never be displaced by optional content.
 */
export function buildWorkContext(context: ServiceContext, identifier: string, maxBytes: number): WorkContext {
  const sources = loadSources(context, identifier);
  const fill: Fill = { descriptionEnd: 0, blockers: 0, parent: false, parentExcerptEnd: 0, candidates: 0, decisions: 0, comments: 0 };
  // Sized with the widest usedBytes (maxBytes) and a same-length fingerprint placeholder.
  const size = (candidate: Fill) => jsonBytes(render(sources, maxBytes, candidate, maxBytes, PLACEHOLDER_FINGERPRINT));
  const fits = (candidate: Fill) => size(candidate) <= maxBytes;
  const minimumBytes = size(fill);
  if (minimumBytes > maxBytes) {
    throw new WorkContextMinimumExceededError(sources.issue.identifier, minimumBytes, maxBytes);
  }
  const description = sources.issue.description;
  if (description) fill.descriptionEnd = fitStringPrefix(description, 0, (slice) => fits({ ...fill, descriptionEnd: slice.length }));
  const admit = (key: "blockers" | "candidates" | "decisions" | "comments", available: number) => {
    while (fill[key] < available && fits({ ...fill, [key]: fill[key] + 1 })) fill[key] += 1;
  };
  admit("blockers", sources.blockers.length);
  if (sources.parent && fits({ ...fill, parent: true })) {
    fill.parent = true;
    const parentDescription = sources.parent.issue.description;
    if (parentDescription) {
      const capped = excerpt(parentDescription, PARENT_EXCERPT_LIMIT).text;
      fill.parentExcerptEnd = fitStringPrefix(capped, 0, (slice) => fits({ ...fill, parentExcerptEnd: slice.length }));
    }
  }
  admit("candidates", sources.routing.candidates.length);
  admit("decisions", Math.min(DECISION_LIMIT, sources.decisions.length));
  admit("comments", Math.min(RECENT_COMMENT_LIMIT, sources.recentComments.length));

  const result = render(sources, maxBytes, fill, 0, PLACEHOLDER_FINGERPRINT);
  result.contextFingerprint = fingerprintOf(result);
  for (let pass = 0; pass < 4; pass += 1) {
    const used = jsonBytes(result);
    if (used === result.budget.usedBytes) break;
    result.budget.usedBytes = used;
  }
  if (result.budget.usedBytes !== jsonBytes(result) || result.budget.usedBytes > maxBytes) {
    throw new AppError(AppErrorCode.DATA_INTEGRITY, "Work context budget accounting failed.", { maxBytes, usedBytes: jsonBytes(result) });
  }
  return result;
}

function compareChanges(left: WorkContextChange, right: WorkContextChange): number {
  const key = (change: WorkContextChange) => [change.kind, "identifier" in change ? change.identifier : "repositoryId" in change ? change.repositoryId : "", "change" in change ? change.change : ""];
  const [a, b] = [key(left), key(right)];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

/** Compares snapshot source revisions with the current ones. */
export function workContextStaleness(stored: WorkContext["sourceRevisions"], current: WorkContext["sourceRevisions"]): WorkContextStaleness {
  const changes: WorkContextChange[] = [];
  if (stored.issue.revision !== current.issue.revision) changes.push({ kind: "issue", identifier: stored.issue.identifier, change: "changed", before: stored.issue.revision, after: current.issue.revision });
  if (stored.parent && current.parent && stored.parent.identifier === current.parent.identifier) {
    if (stored.parent.revision !== current.parent.revision) changes.push({ kind: "parent", identifier: stored.parent.identifier, change: "changed", before: stored.parent.revision, after: current.parent.revision });
  } else {
    if (stored.parent) changes.push({ kind: "parent", identifier: stored.parent.identifier, change: "removed", before: stored.parent.revision, after: null });
    if (current.parent) changes.push({ kind: "parent", identifier: current.parent.identifier, change: "added", before: null, after: current.parent.revision });
  }
  const storedBlockers = new Map(stored.blockers.map((blocker) => [blocker.identifier, blocker.revision]));
  const currentBlockers = new Map(current.blockers.map((blocker) => [blocker.identifier, blocker.revision]));
  for (const [identifier, before] of storedBlockers) {
    const after = currentBlockers.get(identifier);
    if (after === undefined) changes.push({ kind: "blocker", identifier, change: "removed", before, after: null });
    else if (after !== before) changes.push({ kind: "blocker", identifier, change: "changed", before, after });
  }
  for (const [identifier, after] of currentBlockers) if (!storedBlockers.has(identifier)) changes.push({ kind: "blocker", identifier, change: "added", before: null, after });
  if (stableStringify(stored.comments) !== stableStringify(current.comments)) changes.push({ kind: "comments", before: stored.comments, after: current.comments });
  const storedRouting = stored.repositories, currentRouting = current.repositories;
  if (storedRouting.routingFingerprint !== currentRouting.routingFingerprint) {
    const before = { source: storedRouting.source, status: repositoryRoutingStatus(storedRouting.source, storedRouting.entries) };
    const after = { source: currentRouting.source, status: repositoryRoutingStatus(currentRouting.source, currentRouting.entries) };
    if (before.source !== after.source || before.status !== after.status) changes.push({ kind: "routing", before, after });
    const storedEntries = new Map(storedRouting.entries.map((entry) => [entry.repositoryId, entry]));
    const currentEntries = new Map(currentRouting.entries.map((entry) => [entry.repositoryId, entry]));
    for (const [repositoryId, entry] of storedEntries) {
      const next = currentEntries.get(repositoryId);
      if (!next) changes.push({ kind: "repository", repositoryId, change: "removed", before: entry, after: null });
      else if (stableStringify(next) !== stableStringify(entry)) changes.push({ kind: "repository", repositoryId, change: "changed", before: entry, after: next });
    }
    for (const [repositoryId, entry] of currentEntries) if (!storedEntries.has(repositoryId)) changes.push({ kind: "repository", repositoryId, change: "added", before: null, after: entry });
  }
  changes.sort(compareChanges);
  return { stale: changes.length > 0, changes: changes.slice(0, WORK_CONTEXT_MAX_CHANGES), omittedChangeCount: Math.max(0, changes.length - WORK_CONTEXT_MAX_CHANGES) };
}

/**
 * Explicit work-context read shared by CLI and MCP. Live mode builds the context from current
 * state; snapshot mode (`run`) returns the context frozen when that run launched, verbatim, plus
 * the source revisions that changed since. Both run inside one read transaction.
 */
export function getWorkContext(context: ServiceContext, input: GetWorkContextInput): WorkContextResponse {
  const parsed = getWorkContextInputSchema.parse(input);
  return context.db.transaction((db) => {
    const tx = { ...context, db };
    let response: WorkContextResponse;
    if (parsed.run === undefined) {
      response = { mode: "live", runId: null, context: buildWorkContext(tx, parsed.identifier, parsed.maxBytes ?? WORK_CONTEXT_DEFAULT_MAX_BYTES), staleness: null };
    } else {
      const run = tx.db.query.agentRuns.findFirst({ where: eq(agentRuns.id, parsed.run) }).sync();
      if (!run) throw new AppError(AppErrorCode.RUN_NOT_FOUND, `Run ${parsed.run} was not found.`, { run: parsed.run });
      const issue = tx.db.query.issues.findFirst({ where: eq(issues.identifier, parsed.identifier) }).sync();
      if (!issue) throw new AppError(AppErrorCode.ISSUE_NOT_FOUND, `Issue ${parsed.identifier} was not found.`, { identifier: parsed.identifier });
      if (run.issueId !== issue.id) throw new AppError(AppErrorCode.VALIDATION_FAILED, `Run ${run.id} does not belong to issue ${parsed.identifier}.`, { run: run.id, identifier: parsed.identifier });
      const stored = workContextForPrompt(run.resolvedConfiguration);
      if (!stored) throw new AppError(AppErrorCode.VALIDATION_FAILED, `Run ${run.id} has no work-context snapshot.`, { run: run.id });
      response = { mode: "snapshot", runId: run.id, context: stored, staleness: workContextStaleness(stored.sourceRevisions, sourceRevisionsOf(loadSources(tx, parsed.identifier))) };
    }
    workContextResponseSchema.parse(response);
    return response;
  });
}

/**
 * The work context persisted in a run's resolved configuration, returned verbatim, or null for
 * runs launched before work contexts existed. agentd feeds exactly this object to participants.
 */
export function workContextForPrompt(resolvedConfiguration: unknown): WorkContext | null {
  if (!resolvedConfiguration || typeof resolvedConfiguration !== "object" || !("workContext" in resolvedConfiguration)) return null;
  const stored = (resolvedConfiguration as { workContext: unknown }).workContext;
  if (stored === undefined || stored === null) return null;
  const validated = workContextSchema.safeParse(stored);
  if (!validated.success) throw new AppError(AppErrorCode.DATA_INTEGRITY, "Stored run work context is invalid.", { issues: validated.error.issues });
  return stored as WorkContext;
}
