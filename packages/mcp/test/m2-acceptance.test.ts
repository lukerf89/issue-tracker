import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createIssue,
  init,
  openDb,
  uuid,
  whoami,
  type Clock,
  type ServiceContext
} from "@issue-tracker/core";
import { createServer, type McpActorContext } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("M2 acceptance", () => {
  it("lets an MCP agent identify, claim, progress, link, comment, and audit work", async () => {
    const { dbPath, issueIdentifier } = initializedBacklogDb();
    const client = await connectClient(dbPath, {
      type: "agent",
      handle: "orchestration-agent",
      name: "Orchestration Agent"
    });

    try {
      const actor = await callJsonTool<SerializedActor>(client, "whoami", {});
      expect(actor).toMatchObject({
        type: "agent",
        handle: "orchestration-agent",
        name: "Orchestration Agent",
        archivedAt: null
      });
      await expect(callJsonTool<SerializedActor>(client, "get_current_actor", {}))
        .resolves.toEqual(actor);

      const assignable = await callJsonTool<SerializedIssue[]>(client, "list_issues", {
        team: "ENG",
        state: "Todo",
        assignee: null
      });
      expect(assignable.map((issue) => issue.identifier)).toEqual([issueIdentifier]);

      const claimed = await callJsonTool<SerializedIssue>(client, "assign_issue", {
        identifier: issueIdentifier,
        actor: actor.handle
      });
      expect(claimed.assigneeId).toBe(actor.id);

      const started = await callJsonTool<SerializedIssue>(client, "move_issue", {
        identifier: issueIdentifier,
        state: "In Progress"
      });
      expect(started).toMatchObject({
        identifier: issueIdentifier,
        assigneeId: actor.id,
        startedAt: expect.any(String)
      });

      const pr = await callJsonTool<SerializedAttachment>(client, "link_issue", {
        issue: issueIdentifier,
        kind: "pr",
        repoPath: "/workspace/fictional-issue-tracker",
        url: "https://example.invalid/fictional/issue-tracker/pull/76"
      });
      expect(pr).toMatchObject({
        issueId: started.id,
        kind: "pr",
        repoPath: "/workspace/fictional-issue-tracker",
        url: "https://example.invalid/fictional/issue-tracker/pull/76"
      });

      const inReview = await callJsonTool<SerializedIssue>(client, "move_issue", {
        identifier: issueIdentifier,
        state: "In Review"
      });
      expect(inReview).toMatchObject({
        identifier: issueIdentifier,
        assigneeId: actor.id,
        startedAt: started.startedAt
      });

      const comment = await callJsonTool<SerializedComment>(client, "comment_on_issue", {
        issue: issueIdentifier,
        body: "Claimed the issue, linked the fictional PR, and moved it to review."
      });
      expect(comment).toMatchObject({
        issueId: started.id,
        author: { handle: actor.handle },
        parentId: null
      });

      const activity = await callJsonTool<SerializedActivity[]>(client, "list_activity", {
        issue: issueIdentifier
      });
      expect(activity.map((entry) => entry.action)).toEqual([
        "created",
        "assigned",
        "state_changed",
        "linked",
        "state_changed",
        "commented"
      ]);
      expect(activity[0]).toMatchObject({
        action: "created",
        actor: { handle: "owner", type: "human" },
        data: { identifier: issueIdentifier }
      });

      const agentActivity = activity.slice(1);
      expect(agentActivity.map((entry) => ({
        action: entry.action,
        actorId: entry.actorId,
        actorHandle: entry.actor.handle
      }))).toEqual([
        { action: "assigned", actorId: actor.id, actorHandle: actor.handle },
        { action: "state_changed", actorId: actor.id, actorHandle: actor.handle },
        { action: "linked", actorId: actor.id, actorHandle: actor.handle },
        { action: "state_changed", actorId: actor.id, actorHandle: actor.handle },
        { action: "commented", actorId: actor.id, actorHandle: actor.handle }
      ]);
      expect(agentActivity[0]?.data).toMatchObject({
        fromHandle: null,
        toHandle: actor.handle
      });
      expect(agentActivity[1]?.data).toMatchObject({
        fromName: "Todo",
        toName: "In Progress"
      });
      expect(agentActivity[2]?.data).toMatchObject({
        attachmentId: pr.id,
        kind: "pr",
        repoPath: "/workspace/fictional-issue-tracker",
        url: "https://example.invalid/fictional/issue-tracker/pull/76"
      });
      expect(agentActivity[3]?.data).toMatchObject({
        fromName: "In Progress",
        toName: "In Review"
      });
      expect(agentActivity[4]?.data).toMatchObject({
        commentId: comment.id,
        parentId: null
      });
    } finally {
      await client.close();
    }
  });
});

interface SerializedActor {
  id: string;
  type: "agent" | "human";
  name: string;
  handle: string;
  archivedAt: string | null;
}

interface SerializedIssue {
  id: string;
  identifier: string;
  assigneeId: string | null;
  startedAt: string | null;
}

interface SerializedAttachment {
  id: string;
  issueId: string;
  kind: string;
  repoPath: string | null;
  url: string | null;
}

interface SerializedComment {
  id: string;
  issueId: string;
  author: SerializedActor;
  parentId: string | null;
}

interface SerializedActivity {
  action: string;
  actorId: string;
  actor: SerializedActor;
  data: Record<string, unknown>;
}

function initializedBacklogDb(): { dbPath: string; issueIdentifier: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "issue-tracker-m2-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);

  const context: ServiceContext = {
    db,
    actor: null,
    clock: fixedClock("2026-01-01T00:00:00.000Z")
  };

  try {
    const initialized = init(context, {
      workspaceName: "Fictional Workspace",
      teamKey: "ENG",
      teamName: "Engineering",
      actorName: "Human Owner",
      actorHandle: "owner"
    });
    db.$client
      .prepare(
        "insert into workflow_states (id, team_id, name, type, color, position) values (?, ?, ?, ?, ?, ?)"
      )
      .run(uuid(), initialized.team.id, "In Review", "started", "#0F766E", 2.5);

    context.actor = whoami(context);
    const issue = createIssue(context, {
      title: "Implement fictional agent orchestration"
    });

    return { dbPath, issueIdentifier: issue.identifier };
  } finally {
    db.$client.close();
  }
}

async function connectClient(dbPath: string, actor: McpActorContext) {
  const server = createServer({ dbPath, actor });
  const client = new Client({
    name: "issue-tracker-m2-acceptance",
    version: "0.0.0"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

async function callJsonTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await client.callTool({
    name,
    arguments: args
  });
  const [content] = result.content;

  if (!content || content.type !== "text") {
    throw new Error(`Tool ${name} did not return JSON text content.`);
  }

  return JSON.parse(content.text) as T;
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso)
  };
}
