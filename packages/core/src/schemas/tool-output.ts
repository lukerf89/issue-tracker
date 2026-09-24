import { z } from "zod";

import { AppErrorCode } from "../errors.js";
import { runStateSchema } from "./run.js";

/**
 * Shared output contracts for the tracker's machine surfaces (MCP structuredContent, MCP text
 * blocks and CLI --json). Every schema copies a live response envelope exactly: no renamed
 * fields and no normalized cursor types.
 *
 * Each contract is built twice from the same definition:
 * - `exact` uses strict objects everywhere and is what tests validate real responses against;
 * - `advertised` uses loose objects everywhere and is what MCP advertises as outputSchema, so
 *   additive fields (projections, future keys) never fail a client's structuredContent check.
 */

type ObjectFactory = typeof z.strictObject;

/** Timestamps read straight from a stored row (written by the injectable clock as ISO-8601). */
const rowTimestamp = z.string().min(1);

interface BuildOptions {
  object: ObjectFactory;
  /**
   * Serializer timestamps (always Date#toISOString output). Exact contracts check ISO-8601; the
   * advertised ones use a plain string, because the ISO regex adds ~400 bytes per field to tools/list.
   */
  timestamp: z.ZodString | z.ZodISODateTime;
  /** Spell out the optional `fields` projections (exact) or leave them to the loose object (advertised). */
  projections: boolean;
}

function build({ object, timestamp, projections }: BuildOptions) {
  const actor = object({
    id: z.string(),
    type: z.enum(["human", "agent"]),
    name: z.string(),
    handle: z.string(),
    archivedAt: timestamp.nullable()
  });

  const team = object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    issueCounter: z.number().int(),
    archivedAt: timestamp.nullable()
  });

  const workflowState = object({
    id: z.string(),
    teamId: z.string(),
    name: z.string(),
    type: z.string(),
    color: z.string(),
    position: z.number()
  });

  const project = object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    leadId: z.string().nullable(),
    startDate: z.string().nullable(),
    targetDate: z.string().nullable(),
    archivedAt: timestamp.nullable()
  });

  const cycle = object({
    id: z.string(),
    teamId: z.string(),
    number: z.number().int(),
    name: z.string().nullable(),
    startsAt: timestamp,
    endsAt: timestamp
  });

  const label = object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    group: z.string().nullable(),
    archivedAt: timestamp.nullable()
  });

  const issueReference = object({
    id: z.string(),
    identifier: z.string(),
    teamId: z.string(),
    number: z.number().int(),
    title: z.string()
  });

  const comment = object({
    id: z.string(),
    issueId: z.string(),
    authorId: z.string(),
    author: actor,
    body: z.string(),
    parentId: z.string().nullable(),
    createdAt: timestamp
  });

  const attachment = object({
    id: z.string(),
    issueId: z.string(),
    kind: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    repoPath: z.string().nullable(),
    remote: z.string().nullable(),
    branchName: z.string().nullable(),
    commitSha: z.string().nullable(),
    createdAt: timestamp
  });

  const issueShape = {
    id: z.string(),
    identifier: z.string(),
    revision: z.number().int(),
    teamId: z.string(),
    number: z.number().int(),
    title: z.string(),
    description: z.string().nullable(),
    stateId: z.string(),
    priority: z.number().int(),
    assigneeId: z.string().nullable(),
    creatorId: z.string(),
    projectId: z.string().nullable(),
    cycleId: z.string().nullable(),
    parentId: z.string().nullable(),
    parent: issueReference.nullable().optional(),
    children: z.array(issueReference).optional(),
    blockedBy: z.array(issueReference).optional(),
    blocks: z.array(issueReference).optional(),
    comments: z.array(comment).optional(),
    commentCount: z.number().int().optional(),
    hasMoreComments: z.boolean().optional(),
    nextCommentCursor: z.string().nullable().optional(),
    attachments: z.array(attachment).optional(),
    estimate: z.number().nullable(),
    dueDate: z.string().nullable(),
    sortOrder: z.number(),
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    canceledAt: timestamp.nullable(),
    archivedAt: timestamp.nullable(),
    labels: z.array(label)
  };

  /** serializeIssue output (get/claim). */
  const issue = object(issueShape);

  /** Full issue mutation response: serializeIssue plus the replay flag when the service reports one. */
  const issueMutationFull = object({ ...issueShape, alreadyExisted: z.boolean().optional() });

  /** Compact issue mutation receipt (services/issue-receipt.ts IssueReceipt). */
  const issueMutationReceipt = object({
    identifier: z.string(),
    changed: z.boolean(),
    changedFields: z.array(z.string()),
    updatedAt: timestamp,
    revision: z.number().int(),
    alreadyExisted: z.boolean().nullable()
  });

  /**
   * Issue mutation tools answer with either the full issue or the compact receipt (response=full|compact).
   * outputSchema needs an object root, so the advertised contract is the keys both modes share.
   */
  const issueMutation = object({
    identifier: z.string(),
    updatedAt: timestamp,
    revision: z.number().int()
  });

  /** Issue created from a template: always carries the replay flag. */
  const issueFromTemplate = object({ ...issueShape, alreadyExisted: z.boolean() });

  const commentMutation = object({ ...comment.shape, alreadyExisted: z.boolean() });
  const attachmentMutation = object({ ...attachment.shape, alreadyExisted: z.boolean() });

  const projectionShape = {
    stateName: z.string().optional(),
    stateType: z.string().optional(),
    assigneeHandle: z.string().nullable().optional(),
    revision: z.number().int().optional(),
    id: z.string().optional(),
    teamId: z.string().optional(),
    number: z.number().int().optional(),
    description: z.string().nullable().optional(),
    creatorId: z.string().optional(),
    projectId: z.string().nullable().optional(),
    cycleId: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    parent: issueReference.nullable().optional(),
    children: z.array(issueReference).optional(),
    blockedBy: z.array(issueReference).optional(),
    blocks: z.array(issueReference).optional(),
    estimate: z.number().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    sortOrder: z.number().optional(),
    createdAt: timestamp.optional(),
    startedAt: timestamp.nullable().optional(),
    completedAt: timestamp.nullable().optional(),
    canceledAt: timestamp.nullable().optional(),
    archivedAt: timestamp.nullable().optional(),
    labels: z.array(label).optional()
  };

  /** serializeIssueSummary: the six summary keys, optional `fields` projections, and a search snippet. */
  const issueSummary = object({
    identifier: z.string(),
    title: z.string(),
    stateId: z.string(),
    priority: z.number().int(),
    assigneeId: z.string().nullable(),
    updatedAt: timestamp,
    ...(projections ? projectionShape : {}),
    snippet: z.string().optional()
  });

  /** list_issues / search. */
  const issueSummaryPage = object({ issues: z.array(issueSummary), nextCursor: z.string().nullable() });

  const activity = {
    id: z.string(),
    issueId: z.string(),
    actorId: z.string(),
    actor,
    action: z.string(),
    data: z.record(z.string(), z.unknown()),
    createdAt: timestamp
  };
  const activityEntry = object(activity);

  /** list_activity (paged, default). */
  const activityPage = object({
    issue: object({ id: z.string(), identifier: z.string() }),
    entries: z.array(object({ cursor: z.string(), ...activity })),
    cursor: z.string(),
    hasMore: z.boolean()
  });

  /** list_activity_feed. */
  const activityFeed = object({
    events: z.array(object({ cursor: z.string(), issueIdentifier: z.string(), ...activity })),
    cursor: z.string(),
    hasMore: z.boolean()
  });

  const savedView = object({
    id: z.string(),
    name: z.string(),
    filters: z.record(z.string(), z.unknown()),
    description: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const template = object({
    id: z.string(),
    name: z.string(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    priority: z.number().int().nullable(),
    team: z.string().nullable(),
    project: z.string().nullable(),
    labels: z.array(z.string()),
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const builtinView = object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    filters: z.record(z.string(), z.unknown())
  });

  const profile = object({
    id: z.string(),
    name: z.string(),
    workflow: z.string(),
    schemaVersion: z.number().int(),
    configuration: z.record(z.string(), z.unknown()),
    isDefault: z.boolean(),
    isBuiltin: z.boolean(),
    archivedAt: rowTimestamp.nullable(),
    createdAt: rowTimestamp,
    updatedAt: rowTimestamp
  });

  const commandSpec = z.record(z.string(), z.unknown());
  const repository = object({
    id: z.string(),
    name: z.string(),
    canonicalPath: z.string(),
    commonDir: z.string(),
    defaultBranch: z.string(),
    remote: z.string().nullable(),
    setupCommand: commandSpec.nullable(),
    testCommand: commandSpec,
    verificationCommand: commandSpec,
    archivedAt: rowTimestamp.nullable(),
    createdAt: rowTimestamp,
    updatedAt: rowTimestamp
  });

  /** RunSummary (services/run-page.ts): list_runs items and view=summary responses. */
  const runSummary = object({
    id: z.string(),
    issue: object({ id: z.string(), identifier: z.string().nullable() }),
    profileId: z.string().nullable(),
    workflow: z.string(),
    state: runStateSchema,
    phase: z.string(),
    outcome: z.string().nullable(),
    errorCode: z.string().nullable(),
    branch: z.string(),
    parallelGroup: z.string().nullable(),
    attemptCount: z.number().int(),
    eventCount: z.number().int(),
    pending: object({ actions: z.number().int(), inputRequests: z.number().int(), permissionRequests: z.number().int() }),
    createdAt: rowTimestamp,
    updatedAt: rowTimestamp,
    startedAt: rowTimestamp.nullable(),
    lastEventAt: rowTimestamp,
    lastProgressAt: rowTimestamp,
    completedAt: rowTimestamp.nullable(),
    archivedAt: rowTimestamp.nullable()
  });

  const row = z.record(z.string(), z.unknown());
  /** Hydrated run (view=full): the stored run row plus every related collection. */
  const runFull = z.looseObject({
    id: z.string(),
    issueId: z.string(),
    state: runStateSchema,
    resolvedConfiguration: row,
    repositories: z.array(row),
    attempts: z.array(row),
    participants: z.array(row),
    artifacts: z.array(row),
    inputRequests: z.array(row),
    verifications: z.array(row),
    reviewFindings: z.array(row),
    pendingActions: z.array(row)
  });

  const runSummaryPage = object({ runs: z.array(runSummary), nextCursor: z.string().nullable() });

  /** list_run_records and list_run_artifacts. */
  const runRecordsPage = object({
    run: z.string(),
    collection: z.enum(["repositories", "attempts", "participants", "artifacts", "inputRequests", "verifications", "reviewFindings", "pendingActions"]),
    items: z.array(row),
    nextCursor: z.string().nullable()
  });

  const runEvent = object({
    id: z.string(),
    runId: z.string(),
    sequence: z.number().int(),
    attemptId: z.string().nullable(),
    participantId: z.string().nullable(),
    type: z.string(),
    schemaVersion: z.number().int(),
    data: row,
    providerEventId: z.string().nullable(),
    createdAt: rowTimestamp
  });

  /** list_run_events: the cursor is the last event sequence, numeric and never null. */
  const runEventsPage = object({ events: z.array(runEvent), nextCursor: z.number().int().nonnegative() });

  const runMetrics = object({
    totalRuns: z.number().int(),
    activeRuns: z.number().int(),
    outcomes: z.record(z.string(), z.number().int()),
    fallbackCount: z.number().int(),
    stallCount: z.number().int(),
    verificationDisagreementCount: z.number().int(),
    averageDurationMs: z.number().int().nullable()
  });

  /** describe: every section is optional (scoped with `sections`); metadataRevision is always present. */
  const describe = object({
    teams: z.array(object({ id: z.string(), key: z.string(), name: z.string(), states: z.array(workflowState) })).optional(),
    priorities: z.record(z.string(), z.string()).optional(),
    labelGroups: z.unknown().optional(),
    projects: z.array(z.union([project, object({ id: z.string(), name: z.string(), status: z.string() })])).optional(),
    actor: actor.optional(),
    metadataRevision: z.string()
  });

  /** get_issue: an issue projection with budget/omission bookkeeping (loose: fields selects keys). */
  const issueDetail = z.looseObject({ identifier: z.string() });

  /** get_issues and read_issue_section: bounded reads that carry a snapshot fingerprint. */
  const issuesRead = z.looseObject({ issues: z.array(z.looseObject({})) });
  const issueSection = z.looseObject({ identifier: z.string(), path: z.array(z.union([z.string(), z.number()])) });

  return {
    actor, team, workflowState, project, cycle, label, issueReference, comment, attachment,
    issue, issueMutationFull, issueMutationReceipt, issueMutation, issueFromTemplate,
    commentMutation, attachmentMutation, issueSummary, issueSummaryPage,
    activityEntry, activityPage, activityFeed, savedView, template, builtinView, profile, repository,
    runSummary, runFull, runSummaryPage, runRecordsPage, runEvent, runEventsPage, runMetrics,
    describe, issueDetail, issuesRead, issueSection
  };
}

/** Exact (strict) response contracts, validated against real outputs in tests. */
export const exactOutputSchemas = build({ object: z.strictObject, timestamp: z.iso.datetime(), projections: true });
/** Loose variants MCP advertises as outputSchema (object roots; additive keys allowed). */
export const advertisedOutputSchemas = build({ object: z.looseObject as unknown as ObjectFactory, timestamp: z.string(), projections: false });

export type OutputSchemaName = keyof typeof exactOutputSchemas;

/** list_activity full:true: the legacy complete bare array. */
export const activityArraySchema = z.array(exactOutputSchemas.activityEntry);

const appErrorCodes = Object.values(AppErrorCode) as [AppErrorCode, ...AppErrorCode[]];

/** The one error envelope every machine surface returns: errorEnvelope() in core and MCP's tool errors. */
export const errorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(appErrorCodes),
    message: z.string(),
    details: z.unknown().optional()
  })
});

// Named exports for the most-used exact contracts.
export const issueSummaryPageSchema = exactOutputSchemas.issueSummaryPage;
export const issueMutationFullSchema = exactOutputSchemas.issueMutationFull;
export const issueMutationReceiptSchema = exactOutputSchemas.issueMutationReceipt;
export const issueMutationAdvertisedSchema = advertisedOutputSchemas.issueMutation;
export const commentMutationSchema = exactOutputSchemas.commentMutation;
export const attachmentMutationSchema = exactOutputSchemas.attachmentMutation;
export const activityPageSchema = exactOutputSchemas.activityPage;
export const activityFeedSchema = exactOutputSchemas.activityFeed;
export const runSummarySchema = exactOutputSchemas.runSummary;
export const runFullSchema = exactOutputSchemas.runFull;
export const runSummaryPageSchema = exactOutputSchemas.runSummaryPage;
export const runRecordsPageSchema = exactOutputSchemas.runRecordsPage;
export const runEventsPageSchema = exactOutputSchemas.runEventsPage;
