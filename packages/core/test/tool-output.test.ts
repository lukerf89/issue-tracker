import { describe, expect, it } from "vitest";

import {
  AppError, AppErrorCode, activityFeedSchema, activityPageSchema, advertisedOutputSchemas, errorEnvelope, errorEnvelopeSchema,
  exactOutputSchemas, issueMutationReceiptSchema, issueSummaryPageSchema, runEventsPageSchema, runRecordsPageSchema,
  runSummaryPageSchema, toolContract, toolContractNames
} from "../src/index.js";

const at = "2026-01-01T00:00:00.000Z";
const actor = { id: "a1", type: "agent", name: "Fictional Bot", handle: "fictional-bot", archivedAt: null };
const activity = { id: "act1", issueId: "i1", actorId: "a1", actor, action: "created", data: {}, createdAt: at };

describe("error envelope schema", () => {
  it("accepts every errorEnvelope() shape and rejects unknown codes or extra keys", () => {
    for (const error of [new AppError(AppErrorCode.ISSUE_NOT_FOUND, "Issue ENG-9 was not found.", { issue: "ENG-9" }), new AppError(AppErrorCode.VALIDATION_FAILED, "Bad."), new Error("disk"), "plain"]) {
      expect(errorEnvelopeSchema.safeParse(errorEnvelope(error)).success).toBe(true);
    }
    expect(errorEnvelopeSchema.safeParse({ error: { code: "NOT_A_CODE", message: "x" } }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({ error: { code: "ISSUE_NOT_FOUND", message: "x", hint: "y" } }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({ error: { code: "ISSUE_NOT_FOUND", message: "x" }, data: null }).success).toBe(false);
  });
});

describe("page envelopes", () => {
  it("keep each envelope's own field names and cursor types", () => {
    const summary = { identifier: "ENG-1", title: "Set up CI", stateId: "s1", priority: 0, assigneeId: null, updatedAt: at };
    expect(issueSummaryPageSchema.safeParse({ issues: [summary], nextCursor: null }).success).toBe(true);
    expect(issueSummaryPageSchema.safeParse({ items: [summary], nextCursor: null }).success).toBe(false);
    expect(issueSummaryPageSchema.safeParse({ issues: [{ ...summary, bogus: 1 }], nextCursor: null }).success).toBe(false);
    expect(advertisedOutputSchemas.issueSummaryPage.safeParse({ issues: [{ ...summary, futureKey: 1 }], nextCursor: null }).success).toBe(true);

    expect(runEventsPageSchema.safeParse({ events: [], nextCursor: 0 }).success).toBe(true);
    expect(runEventsPageSchema.safeParse({ events: [], nextCursor: "0" }).success).toBe(false);
    expect(runEventsPageSchema.safeParse({ events: [], nextCursor: null }).success).toBe(false);
    expect(runSummaryPageSchema.safeParse({ runs: [], nextCursor: null }).success).toBe(true);
    expect(runSummaryPageSchema.safeParse({ runs: [], nextCursor: 3 }).success).toBe(false);
    expect(runRecordsPageSchema.safeParse({ run: "r1", collection: "artifacts", items: [], nextCursor: null }).success).toBe(true);
    expect(runRecordsPageSchema.safeParse({ run: "r1", collection: "bogus", items: [], nextCursor: null }).success).toBe(false);
    expect(runRecordsPageSchema.safeParse({ runId: "r1", collection: "artifacts", items: [], nextCursor: null }).success).toBe(false);

    expect(activityPageSchema.safeParse({ issue: { id: "i1", identifier: "ENG-1" }, entries: [{ cursor: "1", ...activity }], cursor: "1", hasMore: false }).success).toBe(true);
    expect(activityPageSchema.safeParse({ issue: { id: "i1", identifier: "ENG-1" }, entries: [activity], cursor: "1", hasMore: false }).success).toBe(false);
    expect(activityFeedSchema.safeParse({ events: [{ cursor: "1", issueIdentifier: "ENG-1", ...activity }], cursor: "1", hasMore: true }).success).toBe(true);
    expect(activityFeedSchema.safeParse({ events: [], cursor: 1, hasMore: true }).success).toBe(false);
  });

  it("keeps the compact receipt strict and separate from the full issue", () => {
    const receipt = { identifier: "ENG-1", changed: true, changedFields: ["priority"], updatedAt: at, revision: 2, alreadyExisted: null };
    expect(issueMutationReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(issueMutationReceiptSchema.safeParse({ ...receipt, title: "Set up CI" }).success).toBe(false);
    expect(exactOutputSchemas.issueMutationFull.safeParse(receipt).success).toBe(false);
    expect(advertisedOutputSchemas.issueMutation.safeParse(receipt).success).toBe(true);
  });
});

describe("tool contracts", () => {
  it("throw on unknown tools and keep read-only hints minimal", () => {
    expect(() => toolContract("unknown_tool")).toThrow(/No tool contract/);
    for (const name of toolContractNames()) {
      const { annotations } = toolContract(name);
      if (annotations.readOnlyHint) expect(Object.keys(annotations).sort(), name).toEqual(["openWorldHint", "readOnlyHint", "title"]);
    }
  });
});
