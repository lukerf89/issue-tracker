import { AppError, AppErrorCode, getIssue, listStatesForTeam } from "@issue-tracker/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, expect, it } from "vitest";

import { BUDGETS } from "./budgets.js";
import { contractFixture, type ContractFixture } from "./contract-fixture.js";
import { Recorder, type CallRecord } from "./recorder.js";
import { cursorGuard, readComplete, walkPages, walkSection, type ToolCaller } from "./traversal.js";

/**
 * LF-145: end-to-end fictional agent workloads on a heavy fixture. Every phase runs on its own
 * fresh fixture (so no phase's bytes depend on another's mutations), asserts correctness first,
 * then its per-call and per-phase budgets. Latency is recorded, never asserted; tokens are not
 * measured. WORKLOAD_REPORT=/path writes the measurements.
 */

const recorder = new Recorder();
afterAll(() => recorder.report());

type Budget = { textBytes: number; structuredBytes: number };
type PhaseName = keyof typeof BUDGETS.phases;
const OPEN = ["backlog", "unstarted", "started", "blocked"] as const;
const CLAIMABLE = ["backlog", "unstarted"] as const;
const number = (identifier: string) => Number(identifier.split("-")[1]);
const ascending = (identifiers: string[]) => [...identifiers].sort((a, b) => number(a) - number(b));

/** `find` that fails with a description of what was sought instead of dereferencing undefined. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`workload fixture has no ${what}`);
  return value;
}

function withinCall(label: string, metrics: CallRecord, budget: Budget) {
  expect(metrics.textBytes, `${label} textBytes`).toBeLessThanOrEqual(budget.textBytes);
  expect(metrics.structuredBytes, `${label} structuredBytes`).toBeLessThanOrEqual(budget.structuredBytes);
}

function withinPhase(name: PhaseName) {
  const totals = recorder.phases[name]!;
  const budget = BUDGETS.phases[name];
  expect(totals.toolCalls, `${name} toolCalls`).toBeLessThanOrEqual(budget.toolCalls);
  expect(totals.combinedPayloadBytes, `${name} combinedPayloadBytes`).toBeLessThanOrEqual(budget.combinedPayloadBytes);
  expect(totals.jsonRpcBytes, `${name} jsonRpcBytes`).toBeLessThanOrEqual(budget.jsonRpcBytes);
}

/** Runs a phase on a fresh heavy fixture; correctness is recorded only if every assertion passed. */
async function phase(name: PhaseName, body: (f: ContractFixture, agent: ReturnType<Recorder["agent"]>) => Promise<void>) {
  const f = await contractFixture({ workload: true });
  try {
    const agent = recorder.agent(f, f.writer, name);
    await body(f, agent);
    recorder.correct(name, true);
  } catch (error) {
    recorder.correct(name, false);
    throw error;
  } finally {
    await f.close();
  }
  withinPhase(name);
}

/** Ground truth read straight from the seeded records (not through the paged tool under test). */
function records(f: ContractFixture) {
  const types = new Map(listStatesForTeam(f.context, "ENG").map((state) => [state.id, state.type]));
  const last = number(f.workload!.lastIdentifier);
  const rows = [];
  for (let n = 1; ; n += 1) {
    let issue;
    try {
      issue = getIssue(f.context, `ENG-${n}`);
    } catch (error) {
      // Only "no such issue" ends the scan; anything else is a real failure and propagates.
      if (!(error instanceof AppError && error.code === AppErrorCode.ISSUE_NOT_FOUND)) throw error;
      if (n > last) break;
      throw new Error(`ENG-${n} missing (last seeded is ENG-${last})`, { cause: error });
    }
    rows.push({ identifier: issue.identifier, title: issue.title, stateType: types.get(issue.stateId)!, assigneeId: issue.assigneeId, priority: issue.priority, archived: issue.archivedAt !== null });
  }
  return rows;
}

type Omission = { section: string; unit: "items" | "characters"; omittedCount: number };
type CommentItem = { id: string; body: string };

/**
 * Independent omission check for a work context: from the complete content, work out what each
 * section actually left out, and require omissions to report exactly that many items/characters.
 * Decisions and recent comments are both drawn from the issue's comments, so they are checked
 * together (which comment is a "decision" is core's rule; which comments are missing is not).
 * Repository routing has no read_issue_section path and is not checked here.
 */
function expectOmissionsAccountForCuts(
  payload: {
    sections: {
      task: { description: string | null };
      blockers: { items: Array<{ identifier: string }> };
      parent: { item: { identifier: string } | null };
      decisions: { items: CommentItem[] };
      recentComments: { items: CommentItem[] };
    };
    omissions: Omission[];
  },
  full: { body: string; comments: CommentItem[]; blockedBy: Array<{ identifier: string }>; parent: { identifier: string } | null }
) {
  const reported = (sections: string[], unit: Omission["unit"]) => payload.omissions
    .filter((omission) => sections.includes(omission.section) && omission.unit === unit)
    .reduce((total, omission) => total + omission.omittedCount, 0);
  const { task, blockers, parent, decisions, recentComments } = payload.sections;

  // Task body: the context carries a prefix of the full description.
  const shown = task.description ?? "";
  expect(full.body.startsWith(shown), "task.description is a prefix of the full body").toBe(true);
  const bodyCut = full.body.length - shown.length;
  expect(reported(["task"], "characters"), "task characters omitted").toBe(bodyCut);

  // Comments: whole comments left out, and characters cut from the bodies of included ones.
  const byId = new Map(full.comments.map((comment) => [comment.id, comment.body]));
  const included = [...decisions.items, ...recentComments.items];
  let commentCharsCut = 0;
  for (const item of included) {
    const body = byId.get(item.id);
    expect(body, `comment ${item.id} exists`).toBeDefined();
    expect(body!.startsWith(item.body), `comment ${item.id} body is a prefix`).toBe(true);
    commentCharsCut += body!.length - item.body.length;
  }
  const commentsCut = full.comments.length - new Set(included.map((item) => item.id)).size;
  expect(reported(["decisions", "recentComments"], "items"), "comments omitted").toBe(commentsCut);
  expect(reported(["decisions", "recentComments"], "characters"), "comment characters omitted").toBe(commentCharsCut);

  // Blockers and parent.
  const blockersShown = new Set(blockers.items.map((item) => item.identifier));
  expect(reported(["blockers"], "items"), "blockers omitted").toBe(full.blockedBy.filter((edge) => !blockersShown.has(edge.identifier)).length);
  expect(reported(["parent"], "items"), "parent omitted").toBe(full.parent !== null && parent.item === null ? 1 : 0);

  // The fixture must actually exercise cuts, or the checks above prove nothing.
  expect(bodyCut).toBeGreaterThan(0);
  expect(commentsCut + commentCharsCut).toBeGreaterThan(0);
}

const caller = (call: ReturnType<Recorder["agent"]>["call"]): ToolCaller => call;

it("discovery: identity, tracker description, and full vs coding catalogs", async () => {
  await phase("discovery", async (f, agent) => {
    const me = await agent.call("whoami", {});
    expect(me.data).toMatchObject({ handle: "fictional-agent", type: "agent" });
    const described = await agent.call("describe", {});
    expect(described.isError).toBe(false);
    expect(JSON.stringify(described.data)).toContain("ENG");

    const full = await agent.listTools();
    const coding = recorder.agent(f, await f.connect({ handle: "fictional-agent" }, { toolProfile: "coding" }), "discovery");
    const codingTools = await coding.listTools();
    const fullNames = full.tools.map((tool) => tool.name);
    const codingNames = codingTools.tools.map((tool) => tool.name);
    // The coding profile is a strict subset that still carries the whole agent loop.
    expect(codingNames.every((name) => fullNames.includes(name))).toBe(true);
    expect(codingNames.length).toBeLessThan(fullNames.length);
    for (const name of ["list_issues", "search", "get_work_context", "read_issue_section", "claim_issue", "update_issue", "comment_on_issue", "link_issue", "get_issue"]) {
      expect(codingNames, name).toContain(name);
    }
    // Catalog count/byte ceilings are gated once, in tool-catalog-size.test.ts.
  });
});

it("actionable-work selection: every page, exactly the claimable set, no duplicates", async () => {
  await phase("actionable", async (f, agent) => {
    const truth = records(f);
    const expected = truth.filter((row) => !row.archived && row.assigneeId === null && (CLAIMABLE as readonly string[]).includes(row.stateType)).map((row) => row.identifier);
    expect(expected.length).toBeGreaterThan(20);

    const byFilter = await walkPages(caller(agent.call), "list_issues", { stateTypes: [...CLAIMABLE], assignee: null, limit: 10 });
    expect(byFilter.staleAt).toBeUndefined();
    expect(byFilter.identifiers).toEqual(ascending(expected));
    expect(new Set(byFilter.identifiers).size).toBe(byFilter.identifiers.length);
    expect(byFilter.pages).toBe(Math.ceil(expected.length / 10));

    const byView = await walkPages(caller(agent.call), "list_issues", { view: "builtin:unassigned", stateTypes: [...CLAIMABLE], limit: 10 });
    expect(byView.identifiers).toEqual(byFilter.identifiers);

    // Budgeted reference responses: the default 50-row compact page and five search results.
    const page = await agent.call("list_issues", {});
    expect(page.data.issues).toHaveLength(50);
    expect(Object.keys(page.data.issues[0]).sort()).toEqual(["assigneeId", "identifier", "priority", "stateId", "title", "updatedAt"]);
    withinCall("list_issues default page", page.metrics, BUDGETS.calls.listIssuesDefaultPage);
    const search = await agent.call("search", { query: "workload", limit: 5 });
    expect(search.data.issues).toHaveLength(5);
    withinCall("search 5", search.metrics, BUDGETS.calls.search5);
  });
});

it("requirements retrieval: bounded work context with explicit omissions, then the complete-content path", async () => {
  await phase("requirements", async (f, agent) => {
    const { requirements, hub } = f.workload!;
    const context = await agent.call("get_work_context", { identifier: requirements.identifier });
    expect(context.isError).toBe(false);
    const payload = context.data.context;
    expect(payload.budget.usedBytes).toBeLessThanOrEqual(payload.budget.maxBytes);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(payload.budget.maxBytes);
    // The acceptance criteria are complete even though the body is not.
    expect(payload.sections.acceptanceCriteria).toMatchObject({ found: true, truncated: false, items: requirements.doneWhen });
    for (const omission of payload.omissions) expect(omission.retrieval.mcp.tool).toMatch(/^(read_issue_section|get_issue|get_work_context)$/);
    withinCall("get_work_context default", context.metrics, BUDGETS.calls.workContextDefault);

    // Complete-content path: bounded pages rebuild the body and every comment byte-for-byte.
    const call = caller(agent.call);
    const fullBody = await readComplete(call, requirements.identifier, ["description"]) as string;
    expect(fullBody).toBe(requirements.body);
    const comments = await readComplete(call, requirements.identifier, ["comments"]) as Array<{ id: string; body: string }>;
    expect(comments.map((comment) => comment.body)).toEqual(requirements.comments);

    // Nothing is cut silently. What the context left out is computed from the complete content
    // (not from the context's own truncated flags, which core derives from omissions), and every
    // cut must be reported in omissions with its exact count.
    const blockedBy = await readComplete(call, requirements.identifier, ["blockedBy"]) as Array<{ identifier: string }>;
    const parent = await readComplete(call, requirements.identifier, ["parent"]) as { identifier: string } | null;
    expectOmissionsAccountForCuts(payload, { body: fullBody, comments, blockedBy, parent });

    // Every relationship edge of the hub, paged to completion.
    const identifiers = (entries: unknown[]) => entries.map((entry) => (entry as { identifier: string }).identifier);
    expect(identifiers(await walkSection(call, hub.identifier, ["children"], 5))).toEqual(hub.children);
    expect(identifiers(await walkSection(call, hub.identifier, ["blockedBy"], 5))).toEqual(hub.blockedBy);
    expect(identifiers(await walkSection(call, hub.identifier, ["blocks"], 5))).toEqual(hub.blocks);

    // The verbose legacy read stays available (and budgeted) for full fidelity.
    const verbose = await agent.call("get_issue", { identifier: requirements.identifier });
    expect(verbose.data.description).toBe(requirements.body);
    withinCall("get_issue verbose", verbose.metrics, BUDGETS.calls.getIssueVerbose);
  });
});

it("claim: the first claim wins and a second agent gets an explicit conflict", async () => {
  await phase("claim", async (f, agent) => {
    const target = required(records(f).find((row) => !row.archived && row.assigneeId === null && row.stateType === "unstarted"), "unassigned unstarted issue").identifier;
    const claimed = await agent.call("claim_issue", { identifier: target });
    expect(claimed.isError).toBe(false);
    expect(claimed.data.assigneeId).toBe((await agent.call("whoami", {})).data.id);
    const rival = recorder.agent(f, await f.connect({ handle: "fictional-agent-2" }), "claim");
    const conflict = await rival.call("claim_issue", { identifier: target });
    expect(conflict.isError).toBe(true);
    expect(conflict.data.error).toMatchObject({ code: "ISSUE_ALREADY_CLAIMED", details: { identifier: target, currentRevision: claimed.data.revision } });
  });
});

it("update, comment, and link each land in the activity trail", async () => {
  await phase("update", async (f, agent) => {
    const { requirements } = f.workload!;
    const target = required(records(f).find((row) => !row.archived && row.assigneeId === null && row.stateType === "backlog"), "unassigned backlog issue").identifier;
    await agent.call("claim_issue", { identifier: target });
    const latest = async () => (await agent.call("list_activity", { issue: target })).data.entries.at(-1);

    const updated = await agent.call("update_issue", { identifier: target, priority: 1, response: "compact" });
    expect(updated.data).toMatchObject({ identifier: target, changed: true, changedFields: ["priority"] });
    withinCall("update_issue priority compact", updated.metrics, BUDGETS.calls.updatePriorityCompact);
    expect(await latest()).toMatchObject({ action: "updated", data: { changed: { priority: 1 } }, actor: { handle: "fictional-agent" } });

    const comment = await agent.call("comment_on_issue", { issue: target, body: "Fictional progress: parser wired." });
    expect(comment.isError).toBe(false);
    expect(await latest()).toMatchObject({ action: "commented", data: { commentId: comment.data.id } });

    const link = await agent.call("link_issue", { issue: target, kind: "link", title: "Fictional PR", url: "https://example.test/fictional/pr/1" });
    expect(link.isError).toBe(false);
    expect(await latest()).toMatchObject({ action: "linked", data: { attachmentId: link.data.id, url: "https://example.test/fictional/pr/1" } });

    // The full response on a heavy issue is what compact responses avoid; both are budgeted.
    const full = await agent.call("update_issue", { identifier: requirements.identifier, priority: 3 });
    expect(full.data.description).toBe(requirements.body);
    withinCall("update_issue priority full", full.metrics, BUDGETS.calls.updatePriorityFull);
  });
});

it("recovery after interruption: find claimed work again and resume only on a fresh revision", async () => {
  await phase("recovery", async (f) => {
    const target = required(records(f).find((row) => !row.archived && row.assigneeId === null && row.stateType === "unstarted"), "unassigned unstarted issue").identifier;
    const first: Client = await f.connect({ handle: "fictional-agent" });
    const before = recorder.agent(f, first, "recovery");
    expect((await before.call("claim_issue", { identifier: target })).isError).toBe(false);
    const interrupted = await before.call("update_issue", { identifier: target, priority: 2, response: "compact" });
    const staleRevision = interrupted.data.revision as number;
    await first.close();
    // Meanwhile a human edits the issue, so the agent's remembered revision goes stale.
    const human = await f.connect({ handle: "owner", type: "human" });
    expect((await f.call(human, "update_issue", { identifier: target, title: "Fictional task (edited)", response: "compact" })).isError).toBe(false);

    const resumed = recorder.agent(f, await f.connect({ handle: "fictional-agent" }), "recovery");
    const mine = await walkPages(caller(resumed.call), "list_issues", { assignee: "fictional-agent", stateTypes: [...OPEN] });
    expect(mine.identifiers).toEqual([target]);

    const rejected = await resumed.call("update_issue", { identifier: target, expectedRevision: staleRevision, priority: 4, response: "compact" });
    expect(rejected.data.error).toMatchObject({ code: "ISSUE_CONFLICT", details: { expectedRevision: staleRevision } });
    const current = await resumed.call("get_issue", { identifier: target, fields: ["revision", "priority", "title"] });
    // The rejected write changed nothing.
    expect(current.data.data).toMatchObject({ priority: 2, title: "Fictional task (edited)" });
    const revision = current.data.data.revision as number;
    expect(revision).toBe(rejected.data.error.details.currentRevision);
    const applied = await resumed.call("update_issue", { identifier: target, expectedRevision: revision, priority: 4, response: "compact" });
    expect(applied.data).toMatchObject({ changed: true, revision: revision + 1 });

    // Catching up on a run's event log after the interruption: bounded pages, no gaps, no repeats.
    const sequences: number[] = [];
    const steps: number[] = [];
    const guard = cursorGuard("list_run_events");
    for (let after = 0; ;) {
      const page = await resumed.call("list_run_events", { run: f.seed.run, after, limit: 20 });
      expect(page.data.error, JSON.stringify(page.data.error)).toBeUndefined();
      const events = page.data.events as Array<{ sequence: number; type: string; data: { step?: number } }>;
      if (events.length === 0) break;
      sequences.push(...events.map((event) => event.sequence));
      steps.push(...events.filter((event) => event.type === "fictional.progress").map((event) => event.data.step!));
      if (!(page.data.nextCursor > after)) throw new Error(`list_run_events: nextCursor ${JSON.stringify(page.data.nextCursor)} did not advance past ${after}`);
      guard(page.data.nextCursor);
      after = page.data.nextCursor;
    }
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1));
    expect(steps).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  });
});

it("concurrent mutations during traversal: every traversal completes correctly or signals explicitly", async () => {
  await phase("concurrent", async (f, agent) => {
    const call = caller(agent.call);
    const live = () => records(f).filter((row) => !row.archived);
    // Another agent mutates the workspace between the traversing agent's pages.
    const other = await f.connect({ handle: "fictional-agent-2" });
    const mutate = (name: string, args: Record<string, unknown>) => f.call(other, name, args);

    // (a) Identifier order: edits and archival behind the key, inserts ahead of it.
    const first = await agent.call("list_issues", { limit: 10 });
    const seen = first.data.issues.map((row: { identifier: string }) => row.identifier) as string[];
    const key = number(seen.at(-1)!);
    const ahead = live().filter((row) => number(row.identifier) > key).map((row) => row.identifier);
    expect((await mutate("archive_issue", { identifier: seen[1] })).isError).toBe(false);
    expect((await mutate("update_issue", { identifier: seen[2], title: "Fictional edited behind the key" })).isError).toBe(false);
    const created: string[] = [];
    for (let n = 1; n <= 3; n += 1) created.push((await mutate("create_issue", { title: `Fictional concurrent insert ${n}`, response: "compact" })).data.identifier);
    const rest = await walkPages(call, "list_issues", { limit: 10 }, { cursor: first.data.nextCursor });
    expect(rest.staleAt).toBeUndefined();
    expect(rest.identifiers).toEqual(ascending([...ahead, ...created]));
    expect(seen.filter((identifier) => rest.identifiers.includes(identifier))).toEqual([]);

    // (b) Mutable sorts: an unseen row moving across the key invalidates the cursor explicitly.
    const byPriority = await agent.call("list_issues", { sort: "priority", limit: 10 });
    const prioritySeen = byPriority.data.issues.map((row: { identifier: string }) => row.identifier) as string[];
    const keyRow = byPriority.data.issues.at(-1) as { identifier: string; priority: number };
    const mover = required(live().find((row) => !prioritySeen.includes(row.identifier) && number(row.identifier) < number(keyRow.identifier) && row.priority !== keyRow.priority), "unseen row that can move across the priority key");
    expect((await mutate("update_issue", { identifier: mover.identifier, priority: keyRow.priority, response: "compact" })).isError).toBe(false);
    const stalePriority = await walkPages(call, "list_issues", { sort: "priority", limit: 10 }, { cursor: byPriority.data.nextCursor });
    expect(stalePriority.staleAt?.error.code).toBe("ISSUE_CURSOR_STALE");
    await reconcile(call, "list_issues", { sort: "priority", limit: 50 }, prioritySeen, live().map((row) => row.identifier));

    const byUpdated = await agent.call("list_issues", { sort: "updatedAt", limit: 10 });
    const updatedSeen = byUpdated.data.issues.map((row: { identifier: string }) => row.identifier) as string[];
    const touched = required(live().find((row) => !updatedSeen.includes(row.identifier)), "live row not on the first updatedAt page");
    expect((await mutate("update_issue", { identifier: touched.identifier, title: "Fictional touched mid-walk", response: "compact" })).isError).toBe(false);
    const staleUpdated = await walkPages(call, "list_issues", { sort: "updatedAt", limit: 10 }, { cursor: byUpdated.data.nextCursor });
    expect(staleUpdated.staleAt?.error.code).toBe("ISSUE_CURSOR_STALE");
    await reconcile(call, "list_issues", { sort: "updatedAt", limit: 50 }, updatedSeen, live().map((row) => row.identifier));

    // (c) Search: a relevance change and a membership change each end the walk explicitly or
    // leave it complete; never a silent gap.
    const workload = () => live().filter((row) => row.title.includes("workload")).map((row) => row.identifier);
    const searched = await agent.call("search", { query: "workload", limit: 5 });
    const searchSeen = searched.data.issues.map((row: { identifier: string }) => row.identifier) as string[];
    const boosted = required(workload().find((identifier) => !searchSeen.includes(identifier)), "workload issue not on the first search page");
    expect((await mutate("update_issue", { identifier: boosted, description: "workload workload workload", response: "compact" })).isError).toBe(false);
    const staleSearch = await walkPages(call, "search", { query: "workload", limit: 5 }, { cursor: searched.data.nextCursor });
    expect(staleSearch.staleAt?.error.code).toBe("ISSUE_CURSOR_STALE");
    await reconcile(call, "search", { query: "workload", limit: 25 }, searchSeen, workload());

    const again = await agent.call("search", { query: "workload", limit: 5 });
    const againSeen = again.data.issues.map((row: { identifier: string }) => row.identifier) as string[];
    const joined = (await mutate("create_issue", { title: "Fictional workload late arrival", response: "compact" })).data.identifier as string;
    const continued = await walkPages(call, "search", { query: "workload", limit: 5 }, { cursor: again.data.nextCursor });
    // Either outcome is contract-acceptable: an explicit ISSUE_CURSOR_STALE, or a walk that completes
    // with the new member included. The current behaviour (stale) is pinned so that a change to it is
    // noticed and revisited deliberately; if it changes, assert the complete-walk branch instead:
    //   expect([...againSeen, ...continued.identifiers].sort()).toEqual([...workload()].sort());
    expect(continued.staleAt?.error.code).toBe("ISSUE_CURSOR_STALE");
    await reconcile(call, "search", { query: "workload", limit: 25 }, againSeen, workload());
    expect(workload()).toContain(joined);
  });
});

/** After an explicit stale signal: restart without a cursor; the restart alone is the complete current set. */
async function reconcile(call: ToolCaller, tool: "list_issues" | "search", args: Record<string, unknown>, seen: string[], expected: string[]) {
  const restart = await walkPages(call, tool, args);
  expect(restart.staleAt).toBeUndefined();
  expect(new Set(restart.identifiers).size).toBe(restart.identifiers.length);
  expect([...restart.identifiers].sort()).toEqual([...expected].sort());
  // Rows the agent already saw that still exist are all accounted for.
  expect(seen.filter((identifier) => expected.includes(identifier) && !restart.identifiers.includes(identifier))).toEqual([]);
}

it("CLI parity: the same workload reads identically through tracker --json", async () => {
  await phase("parity", async (f, agent) => {
    const { requirements } = f.workload!;
    const list = await agent.call("list_issues", { stateTypes: [...CLAIMABLE], assignee: null });
    expect(JSON.parse(f.cli(["issue", "list", "--state-types", CLAIMABLE.join(","), "--unassigned", "--json"]))).toEqual(list.data);
    const context = await agent.call("get_work_context", { identifier: requirements.identifier });
    expect(JSON.parse(f.cli(["issue", "context", requirements.identifier, "--json"]))).toEqual(context.data);
  });
});
