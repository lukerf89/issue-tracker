import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addComment, addRepository, applyMigrations, archiveRepository, associateRepository, buildWorkContext, createIssue, createProject, errorEnvelope,
  exportSnapshot, getRun, getWorkContext, importSnapshot, init, moveIssue, openDb, parseAcceptanceCriteria, previewRun, readIssueSection,
  resolveIssueRepositories, resolveIssueRepositoryRouting, startRun, updateIssue, workContextForPrompt, workContextSchema,
  type RepositoryInspector, type ServiceContext
} from "../src/index.js";

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const fakeInspector: RepositoryInspector = {
  inspect: (path, baseRef) => ({ canonicalPath: path, commonDir: `${path}/.git`, defaultBranch: baseRef ?? "main", headCommit: "a".repeat(40), dirty: false, instructionFiles: [], instructions: {} })
};
const command = { executable: "node", args: ["--test"], envNames: [] };

function setup(options: { repositories?: number; defaultRepository?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "issue-tracker-work-context-")); tempDirs.push(root);
  const db = openDb(join(root, "tracker.db")); applyMigrations(db);
  let now = new Date("2026-07-17T12:00:00.000Z").getTime();
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date(now) } };
  const tick = () => { now += 1000; };
  context.actor = init(context, { teamKey: "ENG", actorHandle: "owner" }).actor;
  const project = createProject(context, { name: "Fictional Delivery" });
  const issue = createIssue(context, { title: "Set up CI", projectId: project.id, description: "Wire up the fictional pipeline.\n\n## Done when\n- CI runs on every push\n- Failures block merge\n" });
  const repositories = Array.from({ length: options.repositories ?? 1 }, (_, index) => {
    const repository = addRepository(context, { name: `Repo${index}`, path: join(root, `repo-${index}`), testCommand: command, verificationCommand: command }, fakeInspector);
    associateRepository(context, { repository: repository.id, project: project.id, position: index, isDefault: (options.defaultRepository ?? true) && index === 0, overrideKind: "replace" });
    return repository;
  });
  const runtime = { inspector: fakeInspector, dataRoot: join(root, "data") };
  const launch = (identifier = issue.identifier) => {
    const preview = previewRun(context, { issue: identifier }, runtime);
    return startRun(context, { issue: identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);
  };
  const addRepo = (name: string) => addRepository(context, { name, path: join(root, name), testCommand: command, verificationCommand: command }, fakeInspector);
  return { root, db, context, project, issue, repositories, runtime, launch, addRepo, tick, close: () => db.$client.close() };
}

function captureError(work: () => unknown) {
  try { work(); } catch (error) { return errorEnvelope(error).error; }
  throw new Error("expected failure");
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("work context contract", () => {
  it("bounds large histories with explicit limit omissions, retrieval paths and exact byte accounting", () => {
    const f = setup();
    try {
      for (let n = 0; n < 200; n++) {
        f.tick();
        addComment(f.context, { issue: "ENG-1", body: n % 10 === 0 ? `Decision: fictional choice ${n}` : `Progress note ${n}` });
      }
      const { context } = getWorkContext(f.context, { identifier: "ENG-1" });
      expect(context.budget.usedBytes).toBe(Buffer.byteLength(JSON.stringify(context), "utf8"));
      expect(context.budget.usedBytes).toBeLessThanOrEqual(16384);
      expect(context.sections.decisions.total).toBe(20);
      expect(context.sections.decisions.items.map((item) => item.body)).toEqual([190, 180, 170, 160, 150, 140, 130, 120, 110, 100].map((n) => `Decision: fictional choice ${n}`));
      expect(context.sections.recentComments.total).toBe(180);
      expect(context.sections.recentComments.items.map((item) => item.body)).toEqual(["Progress note 199", "Progress note 198", "Progress note 197", "Progress note 196", "Progress note 195"]);
      expect(context.sections.recentComments.items[0]!.author).toBe("owner");
      expect(context.omissions).toEqual([
        { section: "decisions", reason: "limit", unit: "items", omittedCount: 10, retrieval: context.sections.decisions.retrieval },
        { section: "recentComments", reason: "limit", unit: "items", omittedCount: 175, retrieval: context.sections.recentComments.retrieval }
      ]);
      expect(context.sections.recentComments.truncated).toBe(true);
      expect(context.sections.recentComments.provenance).toEqual({ source: "comments", ids: context.sections.recentComments.items.map((item) => item.id), revision: context.sourceRevisions.issue.revision });
      // The retrieval path is a real call that reaches the omitted history.
      const retrieval = context.sections.recentComments.retrieval;
      expect(retrieval.cli).toBe("tracker issue read-section ENG-1 --path comments --json");
      const page = readIssueSection(f.context, { ...(retrieval.mcp.args as { identifier: string; path: string[] }), limit: 100, maxBytes: 65536 });
      expect((page.value as unknown[]).length).toBe(100);

      // With a tight budget the same history reports budget omissions instead.
      const tight = getWorkContext(f.context, { identifier: "ENG-1", maxBytes: 4096 }).context;
      expect(tight.budget.usedBytes).toBe(bytes(tight));
      expect(tight.budget.usedBytes).toBeLessThanOrEqual(4096);
      expect(tight.sections.acceptanceCriteria.items).toEqual(["CI runs on every push", "Failures block merge"]);
      const omitted = Object.fromEntries(tight.omissions.map((omission) => [omission.section, omission]));
      expect(omitted.recentComments!.omittedCount).toBe(180 - tight.sections.recentComments.items.length);
      expect(omitted.recentComments!.reason).toBe(tight.sections.recentComments.items.length < 5 ? "budget" : "limit");
    } finally { f.close(); }
  });

  it("keeps full acceptance criteria and truncates the description with retrieval at every budget", () => {
    const f = setup();
    try {
      const description = "Intro paragraph.\n" + "Background detail. ".repeat(6000) + "\n\n## Done when\n- CI runs on every push\n- Failures block merge\n- Logs are retained for fictional audits\n";
      updateIssue(f.context, "ENG-1", { description });
      for (const maxBytes of [4096, 8192, 16384, 65536]) {
        const { context } = getWorkContext(f.context, { identifier: "ENG-1", maxBytes });
        expect(context.budget).toEqual({ unit: "utf8_json_bytes", maxBytes, usedBytes: bytes(context) });
        expect(context.budget.usedBytes).toBeLessThanOrEqual(maxBytes);
        expect(context.sections.acceptanceCriteria).toMatchObject({ found: true, truncated: false, items: ["CI runs on every push", "Failures block merge", "Logs are retained for fictional audits"] });
        expect(context.sections.task.truncated).toBe(true);
        expect(description.startsWith(context.sections.task.description!)).toBe(true);
        expect(context.omissions).toContainEqual({ section: "task", reason: "budget", unit: "characters", omittedCount: description.length - context.sections.task.description!.length, retrieval: { mcp: { tool: "read_issue_section", args: { identifier: "ENG-1", path: ["description"] } }, cli: "tracker issue read-section ENG-1 --path description --json" } });
      }
    } finally { f.close(); }
  });

  it("sizes the mandatory minimum first and fails only when that minimum cannot fit", () => {
    const f = setup();
    try {
      // A greedy fill would spend the budget on this description and lose the trailing criteria.
      const criteria = Array.from({ length: 30 }, (_, n) => `Criterion ${n}: ` + "fictional requirement ".repeat(4));
      updateIssue(f.context, "ENG-1", { description: "Detail ".repeat(20000) + "\n## Acceptance criteria\n" + criteria.map((item) => `- ${item.trim()}`).join("\n") });
      const fitted = getWorkContext(f.context, { identifier: "ENG-1", maxBytes: 8192 }).context;
      expect(fitted.sections.acceptanceCriteria.items).toEqual(criteria.map((item) => item.trim()));
      expect(fitted.budget.usedBytes).toBeLessThanOrEqual(8192);
      const error = captureError(() => getWorkContext(f.context, { identifier: "ENG-1", maxBytes: 4096 }));
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.message).toMatch(/minimum/);
      expect((error.details as { minimumBytes: number }).minimumBytes).toBeGreaterThan(4096);
    } finally { f.close(); }
  });

  it("never splits a surrogate pair at the byte boundary", () => {
    const f = setup();
    try {
      updateIssue(f.context, "ENG-1", { description: "🚀".repeat(20000) });
      for (let maxBytes = 4096; maxBytes < 4160; maxBytes++) {
        const { context } = getWorkContext(f.context, { identifier: "ENG-1", maxBytes });
        const text = context.sections.task.description!;
        expect(text.length % 2).toBe(0);
        expect(/[\uD800-\uDBFF]$/.test(text)).toBe(false);
        expect(context.budget.usedBytes).toBe(bytes(context));
        expect(context.budget.usedBytes).toBeLessThanOrEqual(maxBytes);
      }
    } finally { f.close(); }
  });

  it("parses acceptance-criteria headings deterministically", () => {
    expect(parseAcceptanceCriteria("Just prose.\n- a list without a heading")).toEqual({ found: false, items: [] });
    expect(parseAcceptanceCriteria(null)).toEqual({ found: false, items: [] });
    expect(parseAcceptanceCriteria("```\n## Done when\n- fenced example\n```\nText")).toEqual({ found: false, items: [] });
    expect(parseAcceptanceCriteria("**Done when:**\n\n* First\n* Second\n  continued\nAfter")).toEqual({ found: true, items: ["First", "Second continued"] });
    expect(parseAcceptanceCriteria("## Acceptance criteria\n1. One\n2) Two\n- [ ] Three\n- [x] Four\n\n## Notes\n- not a criterion")).toEqual({ found: true, items: ["One", "Two", "[ ] Three", "[x] Four"] });
    expect(parseAcceptanceCriteria("Done when:\n- A\nprose ends it\n- ignored\n### Done when\n+ B")).toEqual({ found: true, items: ["A", "B"] });
  });

  it("reports blocker resolution live and blocker changes against a run snapshot", () => {
    const f = setup();
    try {
      createIssue(f.context, { title: "Provision fictional runners" });
      createIssue(f.context, { title: "Approve fictional budget" });
      updateIssue(f.context, "ENG-1", { blockedBy: ["ENG-2", "ENG-3"] });
      moveIssue(f.context, "ENG-3", "Done");
      const live = getWorkContext(f.context, { identifier: "ENG-1" }).context;
      expect(live.sections.blockers.items.map((item) => [item.identifier, item.resolved])).toEqual([["ENG-2", false], ["ENG-3", true]]);
      expect(live.sections.blockers.unresolvedCount).toBe(1);
      const run = f.launch();

      moveIssue(f.context, "ENG-2", "Done");
      const afterMove = getWorkContext(f.context, { identifier: "ENG-1" }).context;
      expect(afterMove.sections.blockers.items.map((item) => item.resolved)).toEqual([true, true]);
      const snapshot = getWorkContext(f.context, { identifier: "ENG-1", run: run.id });
      expect(snapshot.mode).toBe("snapshot");
      expect(snapshot.context).toEqual(live);
      expect(snapshot.staleness).toMatchObject({ stale: true, omittedChangeCount: 0 });
      expect(snapshot.staleness!.changes).toEqual([{ kind: "blocker", identifier: "ENG-2", change: "changed", before: live.sourceRevisions.blockers[0]!.revision, after: live.sourceRevisions.blockers[0]!.revision + 1 }]);

      createIssue(f.context, { title: "Rotate fictional credentials" });
      updateIssue(f.context, "ENG-1", { blockedBy: ["ENG-4"], removeBlockedBy: ["ENG-3"] });
      const changes = getWorkContext(f.context, { identifier: "ENG-1", run: run.id }).staleness!.changes;
      expect(changes.map((change) => [change.kind, "identifier" in change ? change.identifier : null, "change" in change ? change.change : null])).toEqual([
        ["blocker", "ENG-2", "changed"], ["blocker", "ENG-3", "removed"], ["blocker", "ENG-4", "added"], ["issue", "ENG-1", "changed"]
      ]);
    } finally { f.close(); }
  });

  it("reports parent edits and reparenting as snapshot staleness", () => {
    const f = setup();
    try {
      const parent = createIssue(f.context, { title: "Fictional platform epic", description: "Epic context. ".repeat(200) });
      createIssue(f.context, { title: "Another fictional epic" });
      updateIssue(f.context, "ENG-1", { parent: parent.identifier });
      const live = getWorkContext(f.context, { identifier: "ENG-1" }).context;
      expect(live.sections.parent.item).toMatchObject({ identifier: "ENG-2", descriptionTruncated: true });
      expect(live.sections.parent.item!.descriptionExcerpt!.length).toBe(1000);
      expect(live.omissions).toContainEqual(expect.objectContaining({ section: "parent", reason: "limit", unit: "characters", omittedCount: parent.description!.length - 1000 }));
      const run = f.launch();
      updateIssue(f.context, "ENG-2", { title: "Renamed fictional epic" });
      expect(getWorkContext(f.context, { identifier: "ENG-1", run: run.id }).staleness!.changes).toEqual([{ kind: "parent", identifier: "ENG-2", change: "changed", before: live.sourceRevisions.parent!.revision, after: live.sourceRevisions.parent!.revision + 1 }]);
      updateIssue(f.context, "ENG-1", { parent: "ENG-3" });
      const changes = getWorkContext(f.context, { identifier: "ENG-1", run: run.id }).staleness!.changes;
      expect(changes.filter((change) => change.kind === "parent")).toEqual([
        { kind: "parent", identifier: "ENG-2", change: "removed", before: live.sourceRevisions.parent!.revision, after: null },
        { kind: "parent", identifier: "ENG-3", change: "added", before: null, after: expect.any(Number) }
      ]);
    } finally { f.close(); }
  });

  describe("routing staleness is visible without an issue revision change", () => {
    const cases: Array<[string, (f: ReturnType<typeof setup>) => void, (changes: Array<Record<string, unknown>>) => void]> = [
      ["association added", (f) => associateRepository(f.context, { repository: f.addRepo("Added").id, project: f.project.id, position: 5, isDefault: false, overrideKind: "replace" }),
        (changes) => expect(changes).toEqual([expect.objectContaining({ kind: "repository", change: "added" })])],
      ["association reordered", (f) => associateRepository(f.context, { repository: f.repositories[1]!.id, project: f.project.id, position: 7, isDefault: false, overrideKind: "replace" }),
        (changes) => expect(changes).toEqual([expect.objectContaining({ kind: "repository", repositoryId: expect.any(String), change: "changed", before: expect.objectContaining({ position: 1 }), after: expect.objectContaining({ position: 7 }) })])],
      ["default switched", (f) => associateRepository(f.context, { repository: f.repositories[1]!.id, project: f.project.id, position: 1, isDefault: true, overrideKind: "replace" }),
        (changes) => expect(changes.map((change) => [change.change, (change.after as { isDefault: boolean }).isDefault])).toEqual(expect.arrayContaining([["changed", false], ["changed", true]]))],
      ["override added", (f) => associateRepository(f.context, { repository: f.addRepo("Override").id, issue: "ENG-1", position: 0, isDefault: false, overrideKind: "additional" }),
        (changes) => {
          expect(changes).toContainEqual({ kind: "routing", before: { source: "project", status: "resolved" }, after: { source: "issue_override", status: "resolved" } });
          expect(changes.filter((change) => change.change === "removed")).toHaveLength(2);
          expect(changes.filter((change) => change.change === "added")).toHaveLength(1);
        }],
      ["repository archived", (f) => archiveRepository(f.context, f.repositories[1]!.id),
        (changes) => expect(changes).toEqual([expect.objectContaining({ kind: "repository", repositoryId: expect.any(String), change: "removed", after: null })])]
    ];
    for (const [name, mutate, check] of cases) {
      it(name, () => {
        const f = setup({ repositories: 2 });
        try {
          const run = f.launch();
          const before = getWorkContext(f.context, { identifier: "ENG-1", run: run.id });
          expect(before.staleness).toEqual({ stale: false, changes: [], omittedChangeCount: 0 });
          f.tick();
          mutate(f);
          const after = getWorkContext(f.context, { identifier: "ENG-1", run: run.id });
          expect(after.context).toEqual(before.context);
          expect(after.staleness!.stale).toBe(true);
          expect(after.staleness!.changes.some((change) => change.kind === "issue")).toBe(false);
          check(after.staleness!.changes as Array<Record<string, unknown>>);
        } finally { f.close(); }
      });
    }
  });

  it("reports missing, ambiguous and resolved routing with resolveIssueRepositories semantics", () => {
    const f = setup({ repositories: 2, defaultRepository: false });
    try {
      const routing = (identifier: string) => getWorkContext(f.context, { identifier }).context.sections.repositories;
      const ambiguous = routing("ENG-1");
      expect(ambiguous).toMatchObject({ status: "ambiguous", source: "project", total: 2, primaryRepositoryId: f.repositories[0]!.id });
      expect(ambiguous.candidates.map((candidate) => candidate.id)).toEqual(resolveIssueRepositories(f.context, "ENG-1").map((repository) => repository.id));
      expect(resolveIssueRepositoryRouting(f.context, "ENG-1").candidates.map((candidate) => candidate.id)).toEqual(resolveIssueRepositories(f.context, "ENG-1").map((repository) => repository.id));

      associateRepository(f.context, { repository: f.repositories[1]!.id, project: f.project.id, position: 1, isDefault: true, overrideKind: "replace" });
      expect(routing("ENG-1")).toMatchObject({ status: "resolved", source: "project" });

      createIssue(f.context, { title: "Unrouted fictional chore" });
      expect(routing("ENG-2")).toMatchObject({ status: "missing", source: null, primaryRepositoryId: null, total: 0, candidates: [] });
      expect(resolveIssueRepositories(f.context, "ENG-2")).toEqual([]);

      const override = f.addRepo("Override");
      associateRepository(f.context, { repository: override.id, issue: "ENG-2", position: 0, isDefault: false, overrideKind: "replace" });
      const resolved = routing("ENG-2");
      expect(resolved).toMatchObject({ status: "resolved", source: "issue_override", primaryRepositoryId: override.id });
      expect(resolved.candidates).toEqual([{ id: override.id, name: "Override", defaultBranch: "main", position: 0, isDefault: null, overrideKind: "replace", primary: true }]);
      expect(resolved.candidates.map((candidate) => candidate.id)).toEqual(resolveIssueRepositories(f.context, "ENG-2").map((repository) => repository.id));
    } finally { f.close(); }
  });

  it("is deterministic: identical state gives byte-identical context and fingerprint", () => {
    const f = setup();
    try {
      addComment(f.context, { issue: "ENG-1", body: "Decided: use the fictional runner pool" });
      const first = JSON.stringify(getWorkContext(f.context, { identifier: "ENG-1" }).context);
      const second = JSON.stringify(f.db.transaction((db) => buildWorkContext({ ...f.context, db }, "ENG-1", 16384)));
      expect(second).toBe(first);
      const parsed = workContextSchema.parse(JSON.parse(first));
      expect(parsed.contextFingerprint).toMatch(/^[0-9a-f]{64}$/);
      addComment(f.context, { issue: "ENG-1", body: "Progress update" });
      expect(getWorkContext(f.context, { identifier: "ENG-1" }).context.contextFingerprint).not.toBe(parsed.contextFingerprint);
    } finally { f.close(); }
  });

  it("validates snapshot reads: no maxBytes with run, legacy runs, and run/issue mismatch", () => {
    const f = setup();
    try {
      const run = f.launch();
      expect(captureError(() => getWorkContext(f.context, { identifier: "ENG-1", run: run.id, maxBytes: 8192 })).code).toBe("VALIDATION_FAILED");
      createIssue(f.context, { title: "Unrelated fictional task" });
      expect(captureError(() => getWorkContext(f.context, { identifier: "ENG-2", run: run.id })).code).toBe("VALIDATION_FAILED");
      expect(captureError(() => getWorkContext(f.context, { identifier: "ENG-1", run: "00000000-0000-4000-8000-000000000000" })).code).toBe("RUN_NOT_FOUND");
      const legacy = { ...(getRun(f.context, run.id).resolvedConfiguration as Record<string, unknown>) };
      delete legacy.workContext;
      f.db.$client.prepare("update agent_runs set resolved_configuration = ? where id = ?").run(JSON.stringify(legacy), run.id);
      expect(workContextForPrompt(getRun(f.context, run.id).resolvedConfiguration)).toBeNull();
      const error = captureError(() => getWorkContext(f.context, { identifier: "ENG-1", run: run.id }));
      expect(error).toMatchObject({ code: "VALIDATION_FAILED", message: `Run ${run.id} has no work-context snapshot.` });
    } finally { f.close(); }
  });
});

describe("run launch freezes the work context", () => {
  it("stores the live context verbatim and rejects starts after context changes", () => {
    const f = setup();
    try {
      const live = getWorkContext(f.context, { identifier: "ENG-1" }).context;
      const run = f.launch();
      const stored = (run.resolvedConfiguration as { workContext: unknown }).workContext;
      expect(stored).toEqual(live);
      expect(JSON.stringify(stored)).toBe(JSON.stringify(live));
      expect(workContextSchema.parse(stored)).toEqual(live);
      expect(workContextForPrompt(run.resolvedConfiguration)).toEqual(live);
    } finally { f.close(); }
  });

  it("raises RUN_PREVIEW_STALE when a comment lands between preview and start", () => {
    const f = setup();
    try {
      const preview = previewRun(f.context, { issue: "ENG-1" }, f.runtime);
      addComment(f.context, { issue: "ENG-1", body: "Decision: switch fictional runners" });
      expect(captureError(() => startRun(f.context, { issue: "ENG-1", previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, f.runtime)).code).toBe("RUN_PREVIEW_STALE");
    } finally { f.close(); }
  });

  it("raises RUN_PREVIEW_STALE when routing changes between preview and start without an issue revision", () => {
    const f = setup({ repositories: 2 });
    try {
      const preview = previewRun(f.context, { issue: "ENG-1" }, f.runtime);
      associateRepository(f.context, { repository: f.repositories[1]!.id, project: f.project.id, position: 1, isDefault: true, overrideKind: "replace" });
      expect(captureError(() => startRun(f.context, { issue: "ENG-1", previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, f.runtime)).code).toBe("RUN_PREVIEW_STALE");
      const fresh = previewRun(f.context, { issue: "ENG-1" }, f.runtime);
      expect(startRun(f.context, { issue: "ENG-1", previewFingerprint: fresh.previewFingerprint, confirmWarnings: fresh.warnings }, f.runtime).state).toBe("queued");
    } finally { f.close(); }
  });

  it("round-trips runs with and without a work-context snapshot through export and import", () => {
    const f = setup();
    try {
      const run = f.launch();
      createIssue(f.context, { title: "Legacy fictional run", projectId: f.project.id });
      const legacyRun = f.launch("ENG-2");
      const legacy = { ...(getRun(f.context, legacyRun.id).resolvedConfiguration as Record<string, unknown>) };
      delete legacy.workContext;
      f.db.$client.prepare("update agent_runs set resolved_configuration = ? where id = ?").run(JSON.stringify(legacy), legacyRun.id);
      const snapshot = exportSnapshot(f.context);
      const root = mkdtempSync(join(tmpdir(), "issue-tracker-work-context-import-")); tempDirs.push(root);
      const db = openDb(join(root, "tracker.db")); applyMigrations(db);
      const target: ServiceContext = { db, actor: null, clock: f.context.clock };
      try {
        importSnapshot(target, snapshot);
        expect(getRun(target, run.id).resolvedConfiguration).toEqual(getRun(f.context, run.id).resolvedConfiguration);
        expect(getWorkContext(target, { identifier: "ENG-1", run: run.id }).context).toEqual(getWorkContext(f.context, { identifier: "ENG-1", run: run.id }).context);
        expect(workContextForPrompt(getRun(target, legacyRun.id).resolvedConfiguration)).toBeNull();
      } finally { db.$client.close(); }
    } finally { f.close(); }
  });
});
