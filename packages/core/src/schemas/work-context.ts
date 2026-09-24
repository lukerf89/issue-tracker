import { z } from "zod";

import { nonEmptyStringSchema } from "./common.js";

// LF-144 work-context contract. `workContextSchema` is the immutable, budgeted payload that is
// persisted verbatim in a run snapshot and fed verbatim to agentd participants. The response
// envelope (mode/runId/staleness) wraps it and is not part of the budget.

export const WORK_CONTEXT_DEFAULT_MAX_BYTES = 16384;
export const WORK_CONTEXT_MAX_CHANGES = 50;

export const getWorkContextInputSchema = z.strictObject({
  identifier: nonEmptyStringSchema,
  run: z.string().min(1).max(128).optional().describe("Read the immutable snapshot captured when this run launched and report stale source revisions."),
  maxBytes: z.number().int().min(4096).max(65536).optional().describe("Live-mode UTF-8 JSON byte budget for the context payload (default 16384). Not allowed with run.")
}).superRefine((input, context) => {
  if (input.run !== undefined && input.maxBytes !== undefined) {
    context.addIssue({ code: "custom", path: ["maxBytes"], message: "maxBytes cannot be combined with run; snapshots have a fixed budget." });
  }
});

const timestamp = z.string().datetime({ offset: true });
const stateTypeSchema = z.enum(["backlog", "unstarted", "started", "blocked", "completed", "canceled"]);
const overrideKindSchema = z.enum(["replace", "additional"]);
const routingSourceSchema = z.enum(["issue_override", "project"]).nullable();
const routingStatusSchema = z.enum(["resolved", "ambiguous", "missing"]);
const sectionNameSchema = z.enum(["task", "acceptanceCriteria", "blockers", "parent", "repositories", "decisions", "recentComments"]);

export const workContextRetrievalSchema = z.strictObject({
  mcp: z.strictObject({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()) }),
  cli: z.string().min(1)
});
const provenanceSchema = z.strictObject({
  source: z.string().min(1),
  ids: z.array(z.string()),
  revision: z.number().int().positive().nullable()
});
const sectionBase = { provenance: provenanceSchema, retrieval: workContextRetrievalSchema, truncated: z.boolean() };
const stateSchema = z.strictObject({ name: z.string(), type: stateTypeSchema });
const revisionRefSchema = z.strictObject({ identifier: z.string().min(1), revision: z.number().int().positive() });
// Comments are append-only and never bump issue.revision, so the comment history gets its own
// watermark: a new comment (decision or not) always changes count and latestCommentId.
export const workContextCommentWatermarkSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  decisionCount: z.number().int().nonnegative(),
  latestCommentId: z.string().min(1).nullable(),
  latestCreatedAt: z.string().datetime({ offset: true }).nullable()
});

export const workContextRoutingEntrySchema = z.strictObject({
  repositoryId: z.string().min(1),
  position: z.number().int().nonnegative(),
  isDefault: z.boolean().nullable(),
  overrideKind: overrideKindSchema.nullable(),
  updatedAt: timestamp
});

const commentItemSchema = z.strictObject({
  id: z.string().min(1),
  author: z.string().nullable(),
  createdAt: timestamp,
  body: z.string(),
  bodyTruncated: z.boolean()
});

export const workContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  budget: z.strictObject({ unit: z.literal("utf8_json_bytes"), maxBytes: z.number().int().positive(), usedBytes: z.number().int().nonnegative() }),
  sourceRevisions: z.strictObject({
    issue: revisionRefSchema,
    parent: revisionRefSchema.nullable(),
    blockers: z.array(revisionRefSchema),
    comments: workContextCommentWatermarkSchema,
    repositories: z.strictObject({
      routingFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      source: routingSourceSchema,
      entries: z.array(workContextRoutingEntrySchema)
    })
  }),
  contextFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  sections: z.strictObject({
    task: z.strictObject({
      ...sectionBase,
      identifier: z.string().min(1),
      title: z.string(),
      state: stateSchema,
      priority: z.number().int(),
      revision: z.number().int().positive(),
      description: z.string().nullable()
    }),
    acceptanceCriteria: z.strictObject({ ...sectionBase, found: z.boolean(), items: z.array(z.string()) }),
    blockers: z.strictObject({
      ...sectionBase,
      total: z.number().int().nonnegative(),
      unresolvedCount: z.number().int().nonnegative(),
      items: z.array(z.strictObject({ identifier: z.string().min(1), title: z.string(), state: stateSchema, resolved: z.boolean(), revision: z.number().int().positive() }))
    }),
    parent: z.strictObject({
      ...sectionBase,
      item: z.strictObject({
        identifier: z.string().min(1), title: z.string(), state: stateSchema, revision: z.number().int().positive(),
        descriptionExcerpt: z.string().nullable(), descriptionTruncated: z.boolean()
      }).nullable()
    }),
    repositories: z.strictObject({
      ...sectionBase,
      status: routingStatusSchema,
      source: routingSourceSchema,
      primaryRepositoryId: z.string().nullable(),
      total: z.number().int().nonnegative(),
      candidates: z.array(z.strictObject({
        id: z.string().min(1), name: z.string().min(1), defaultBranch: z.string().min(1), position: z.number().int().nonnegative(),
        isDefault: z.boolean().nullable(), overrideKind: overrideKindSchema.nullable(), primary: z.boolean()
      }))
    }),
    decisions: z.strictObject({ ...sectionBase, total: z.number().int().nonnegative(), items: z.array(commentItemSchema) }),
    recentComments: z.strictObject({ ...sectionBase, total: z.number().int().nonnegative(), items: z.array(commentItemSchema) })
  }),
  omissions: z.array(z.strictObject({
    section: sectionNameSchema,
    reason: z.enum(["budget", "limit"]),
    unit: z.enum(["items", "characters"]),
    omittedCount: z.number().int().positive(),
    retrieval: workContextRetrievalSchema
  }))
});

const revisionChangeSchema = (kind: "issue" | "parent" | "blocker") => z.strictObject({
  kind: z.literal(kind),
  identifier: z.string().min(1),
  change: z.enum(["added", "removed", "changed"]),
  before: z.number().int().positive().nullable(),
  after: z.number().int().positive().nullable()
});

export const workContextChangeSchema = z.discriminatedUnion("kind", [
  revisionChangeSchema("blocker"),
  revisionChangeSchema("issue"),
  revisionChangeSchema("parent"),
  z.strictObject({
    kind: z.literal("repository"),
    repositoryId: z.string().min(1),
    change: z.enum(["added", "removed", "changed"]),
    before: workContextRoutingEntrySchema.nullable(),
    after: workContextRoutingEntrySchema.nullable()
  }),
  z.strictObject({
    kind: z.literal("comments"),
    before: workContextCommentWatermarkSchema,
    after: workContextCommentWatermarkSchema
  }),
  z.strictObject({
    kind: z.literal("routing"),
    before: z.strictObject({ source: routingSourceSchema, status: routingStatusSchema }),
    after: z.strictObject({ source: routingSourceSchema, status: routingStatusSchema })
  })
]);

export const workContextStalenessSchema = z.strictObject({
  stale: z.boolean(),
  changes: z.array(workContextChangeSchema).max(WORK_CONTEXT_MAX_CHANGES),
  omittedChangeCount: z.number().int().nonnegative()
});

export const workContextResponseSchema = z.strictObject({
  mode: z.enum(["live", "snapshot"]),
  runId: z.string().nullable(),
  context: workContextSchema,
  staleness: workContextStalenessSchema.nullable()
}).superRefine((response, context) => {
  if ((response.mode === "live") !== (response.runId === null && response.staleness === null)) {
    context.addIssue({ code: "custom", message: "Live responses carry no runId or staleness; snapshot responses carry both." });
  }
});

export type GetWorkContextInput = z.input<typeof getWorkContextInputSchema>;
export type WorkContext = z.infer<typeof workContextSchema>;
export type WorkContextRoutingEntry = z.infer<typeof workContextRoutingEntrySchema>;
export type WorkContextChange = z.infer<typeof workContextChangeSchema>;
export type WorkContextStaleness = z.infer<typeof workContextStalenessSchema>;
export type WorkContextResponse = z.infer<typeof workContextResponseSchema>;
