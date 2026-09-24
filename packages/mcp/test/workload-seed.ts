import {
  addAttachment, addComment, appendRunEvent, archiveIssue, assignIssue, associateRepository, createIssue, createLabel, updateIssue, whoami,
  type ServiceContext
} from "@issue-tracker/core";

/**
 * A heavy, deterministic, fictional workload layered on the contract seed (LF-145):
 * - 60 mixed-state/priority "workload" tasks, some assigned to the human, a few archived;
 * - one requirements issue with a ~40 KB multi-section body and 30 ~2 KB comments;
 * - one hub issue with 22 relation edges (children, blockers, blocked), 12 labels and 5 links;
 * - on the requirements issue, populated relation sections for its work context: a parent with a
 *   long description, 6 open blockers and a 2-repository routing override (the contract seed's
 *   Primary and Secondary repositories). They are created after the hub, so earlier identifiers
 *   are unchanged;
 * - 50 appended events on the contract seed's run (when a run id is given).
 * Seeded only through the core barrel, on its own advancing clock so every byte is reproducible.
 * Returns what the seed did (never what a query later reports), so tests can compare against it.
 */
export function seedWorkload(context: ServiceContext, runId: string | null) {
  const previousClock = context.clock;
  let at = Date.parse("2026-01-02T00:00:00.000Z");
  context.clock = { now: () => new Date((at += 1000)) };
  try {
    const human = whoami(context);
    const states = ["Backlog", "Todo", "In Progress", "Blocked", "Done", "Canceled", "Todo", "Backlog"] as const;

    const workload: string[] = [];
    const archivedWorkload: string[] = [];
    for (let n = 1; n <= 60; n += 1) {
      const issue = createIssue(context, {
        title: `Fictional workload task ${n}`,
        description: `Fictional workload body ${n}.\n\n` + `Step ${n}: exercise the fictional pipeline.\n`.repeat(n % 7 + 1),
        state: states[n % states.length],
        priority: n % 5
      });
      if (n % 4 === 0) assignIssue(context, issue.identifier, human.id);
      if (n % 15 === 7) {
        archiveIssue(context, issue.identifier);
        archivedWorkload.push(issue.identifier);
      }
      workload.push(issue.identifier);
    }

    // Requirements: ~40 KB of sections, with a Done-when list the work context must surface whole.
    const doneWhen = Array.from({ length: 12 }, (_, n) => `Fictional acceptance gate ${n + 1} holds under the fictional load`);
    const sections = Array.from({ length: 18 }, (_, s) =>
      `## Fictional section ${s + 1}\n\n` + `Paragraph ${s + 1}: the fictional service must keep every fictional record intact. `.repeat(28) + "\n"
    );
    const requirementsBody = `# Fictional requirements\n\n${sections.join("\n")}\nDone when:\n${doneWhen.map((item) => `- ${item}`).join("\n")}\n`;
    const requirements = createIssue(context, { title: "Fictional requirements for the importer", description: requirementsBody, state: "Todo", priority: 2 });
    const commentBodies: string[] = [];
    for (let n = 0; n < 30; n += 1) {
      const lead = n % 6 === 0 ? `Decision: fictional choice ${n}.` : `Fictional review note ${n}.`;
      const body = `${lead} ` + `Detail ${n} about the fictional importer behaviour. `.repeat(48);
      addComment(context, { issue: requirements.identifier, body });
      commentBodies.push(body);
    }

    // Hub: many relationships and metadata.
    const hub = createIssue(context, { title: "Fictional hub epic", description: "Coordinates the fictional migration.", state: "Todo", priority: 1 });
    const children: string[] = [];
    const blockedBy: string[] = [];
    const blocks: string[] = [];
    for (let n = 1; n <= 8; n += 1) children.push(createIssue(context, { title: `Fictional hub child ${n}`, parent: hub.identifier, state: "Backlog", priority: 3 }).identifier);
    for (let n = 1; n <= 7; n += 1) blockedBy.push(createIssue(context, { title: `Fictional hub blocker ${n}`, blocks: [hub.identifier], state: "In Progress", priority: 2 }).identifier);
    for (let n = 1; n <= 7; n += 1) blocks.push(createIssue(context, { title: `Fictional hub dependant ${n}`, blockedBy: [hub.identifier], state: "Todo", priority: 4 }).identifier);
    const labels: string[] = [];
    for (let n = 1; n <= 12; n += 1) labels.push(createLabel(context, { name: `fictional-area-${String(n).padStart(2, "0")}` }).name);
    updateIssue(context, hub.identifier, { labels });
    const links: string[] = [];
    for (let n = 1; n <= 5; n += 1) {
      const url = `https://example.test/fictional/hub/${n}`;
      addAttachment(context, { issue: hub.identifier, kind: "link", title: `Fictional hub link ${n}`, url });
      links.push(url);
    }

    // Requirements relations, so a bounded work context has populated blockers/parent/repositories.
    const parent = createIssue(context, {
      title: "Fictional importer initiative",
      description: "Fictional initiative overview. " + "The fictional importer initiative spans many fictional teams. ".repeat(40),
      state: "In Progress", priority: 1
    });
    updateIssue(context, requirements.identifier, { parent: parent.identifier });
    const requirementsBlockers: string[] = [];
    for (let n = 1; n <= 6; n += 1) {
      requirementsBlockers.push(createIssue(context, { title: `Fictional importer prerequisite ${n}`, blocks: [requirements.identifier], state: "In Progress", priority: 2 }).identifier);
    }
    const requirementsRepositories = ["Primary", "Secondary"];
    requirementsRepositories.forEach((repository, position) => associateRepository(context, { repository, issue: requirements.identifier, position, isDefault: false, overrideKind: "replace" }));

    for (let n = 1; runId !== null && n <= 50; n += 1) {
      appendRunEvent(context, { runId, type: "fictional.progress", data: { step: n, note: `Fictional progress ${n}` }, progress: true });
    }

    return {
      workload, archivedWorkload,
      requirements: {
        identifier: requirements.identifier, body: requirementsBody, doneWhen, comments: commentBodies,
        parent: parent.identifier, blockedBy: requirementsBlockers, repositories: requirementsRepositories
      },
      hub: { identifier: hub.identifier, children, blockedBy, blocks, labels, links },
      lastIdentifier: requirementsBlockers.at(-1)!
    };
  } finally {
    context.clock = previousClock;
  }
}

export type Workload = ReturnType<typeof seedWorkload>;
