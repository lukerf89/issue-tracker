import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addRepository, applyMigrations, associateRepository, claimRunAction, completeRunAction, createIssue,
  createNodeRepositoryInspector, createProject, getRun, init, listRunEvents, openDb, previewRun,
  resolveRunPermission, startRun, type ServiceContext
} from "@issue-tracker/core";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { describeOperation, runPermissionHook } from "../src/permission-hook.js";

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const WRITE_CALL = JSON.stringify({
  session_id: "session-fictional", tool_name: "Write", tool_use_id: "toolu_fictional",
  cwd: "/fictional/worktree", tool_input: { file_path: "/fictional/worktree/GREETING.md", content: "hi\n" }
});

describe("durable provider permission hook", () => {
  it("denies when no approval route is configured", async () => {
    expect(decisionOf(await runPermissionHook(WRITE_CALL, {}))).toMatchObject({ permissionDecision: "deny" });
    expect(decisionOf(await runPermissionHook(WRITE_CALL, { ISSUE_TRACKER_DB: "/tmp/x.db", ISSUE_TRACKER_RUN_ID: "run" }))).toMatchObject({ permissionDecision: "deny" });
  });

  it("denies malformed and unreachable requests rather than defaulting open", async () => {
    const fixture = setup();
    try {
      expect(decisionOf(await runPermissionHook("{not json", fixture.env()))).toMatchObject({ permissionDecision: "deny" });
      // A participant that is not live cannot own a request, so requestRunInput throws and the
      // hook must still produce a denial rather than propagate the error as an approval.
      const denied = decisionOf(await runPermissionHook(WRITE_CALL, { ...fixture.env(), ISSUE_TRACKER_PARTICIPANT_ID: "participant-that-does-not-exist" }));
      expect(denied).toMatchObject({ permissionDecision: "deny" });
      expect(denied.permissionDecisionReason).toMatch(/failed/i);
    } finally { fixture.close(); }
  });

  it("records a durable request describing the operation and allows once approved", async () => {
    const fixture = setup();
    try {
      const approver = setTimeout(() => {
        const pending = getRun(fixture.context, fixture.runId).inputRequests.find((candidate) => candidate.state === "pending")!;
        resolveRunPermission(fixture.context, { run: fixture.runId, request: pending.id, decision: "approved" });
      }, 50);
      const result = decisionOf(await runPermissionHook(WRITE_CALL, { ...fixture.env(), ISSUE_TRACKER_PERMISSION_POLL_MS: "10" }));
      clearTimeout(approver);

      expect(result).toMatchObject({ permissionDecision: "allow" });
      const request = getRun(fixture.context, fixture.runId).inputRequests.at(-1)!;
      expect(request).toMatchObject({ kind: "permission", delivery: "hook", state: "approved", blocking: true });
      expect(request.operation).toMatchObject({ tool: "Write", scope: "/fictional/worktree/GREETING.md", toolUseId: "toolu_fictional" });
      expect(request.prompt).toContain("GREETING.md");
    } finally { fixture.close(); }
  });

  it("denies when the operator denies, and never enqueues a duplicate resume subprocess", async () => {
    const fixture = setup();
    try {
      const denier = setTimeout(() => {
        const pending = getRun(fixture.context, fixture.runId).inputRequests.find((candidate) => candidate.state === "pending")!;
        resolveRunPermission(fixture.context, { run: fixture.runId, request: pending.id, decision: "denied" });
      }, 50);
      const result = decisionOf(await runPermissionHook(WRITE_CALL, { ...fixture.env(), ISSUE_TRACKER_PERMISSION_POLL_MS: "10" }));
      clearTimeout(denier);

      expect(result).toMatchObject({ permissionDecision: "deny" });
      // The provider process is alive and polling, so delivering by resume would orphan it.
      expect(getRun(fixture.context, fixture.runId).pendingActions.filter((action) => action.kind === "deliver_input")).toEqual([]);
    } finally { fixture.close(); }
  });

  it("degrades to resume delivery when no operator answers within the bounded wait", async () => {
    const fixture = setup();
    try {
      const result = decisionOf(await runPermissionHook(WRITE_CALL, { ...fixture.env(), ISSUE_TRACKER_PERMISSION_TIMEOUT_MS: "60", ISSUE_TRACKER_PERMISSION_POLL_MS: "10", ISSUE_TRACKER_PERMISSION_PROGRESS_MS: "20" }));
      expect(result).toMatchObject({ permissionDecision: "deny" });
      expect(result.permissionDecisionReason).toMatch(/remains pending/i);

      const request = getRun(fixture.context, fixture.runId).inputRequests.at(-1)!;
      expect(request).toMatchObject({ state: "pending", delivery: "resume" });

      // Progress events keep the run out of stall detection while a human deliberates.
      const types = listRunEvents(fixture.context, { run: fixture.runId }).events.map((event) => event.type);
      expect(types).toContain("permission.waiting");
      expect(types).toContain("permission.wait_expired");

      // A late approval now reaches the provider by restarting the session.
      resolveRunPermission(fixture.context, { run: fixture.runId, request: request.id, decision: "approved" });
      expect(getRun(fixture.context, fixture.runId).pendingActions.some((action) => action.kind === "deliver_input")).toBe(true);
    } finally { fixture.close(); }
  });

  it("summarizes the affected scope for each gated tool shape", () => {
    expect(describeOperation({ tool_name: "Bash", tool_input: { command: "git commit -m fictional" } })).toMatchObject({ tool: "Bash", scope: "git commit -m fictional" });
    expect(describeOperation({ tool_name: "WebFetch", tool_input: { url: "https://example.test" } })).toMatchObject({ scope: "https://example.test" });
    expect(describeOperation({ tool_name: "Edit", tool_input: {} })).toMatchObject({ tool: "Edit", scope: null, summary: "Edit" });
  });
});

function decisionOf(raw: string) {
  return (JSON.parse(raw) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "issue-tracker-permission-")); tempDirs.push(root);
  const dbPath = join(root, "tracker.db");
  const db = openDb(dbPath); applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date() } };
  const initialized = init(context, { teamKey: "ENG", actorHandle: "owner" }); context.actor = initialized.actor;
  const project = createProject(context, { name: "Fictional Permission" });
  const issue = createIssue(context, { title: "Gate the fictional write", projectId: project.id });
  const repository = createGitRepository(root);
  const registered = addRepository(context, { name: "Primary", path: repository, testCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], envNames: [] }, verificationCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], envNames: [] } }, createNodeRepositoryInspector());
  associateRepository(context, { repository: registered.id, project: project.id, position: 0, isDefault: true, overrideKind: "replace" });

  const runtime = { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data") };
  const preview = previewRun(context, { issue: issue.identifier }, runtime);
  const started = startRun(context, { issue: issue.identifier, previewFingerprint: preview.previewFingerprint, confirmWarnings: preview.warnings }, runtime);
  const provision = claimRunAction(context, { supervisorId: "agentd" })!;
  completeRunAction(context, { actionId: provision.id, supervisorId: "agentd", result: {} });
  const planner = getRun(context, started.id).participants.find((participant) => participant.role === "planner")!;
  // The supervisor marks a participant running when it launches; this fixture stands in for that.
  db.$client.prepare("update run_participants set state = ?, started_at = ? where id = ?").run("running", context.clock.now().toISOString(), planner.id);

  return {
    context, runId: started.id, participantId: planner.id,
    env: () => ({ ISSUE_TRACKER_DB: dbPath, ISSUE_TRACKER_RUN_ID: started.id, ISSUE_TRACKER_PARTICIPANT_ID: planner.id }),
    close: () => db.$client.close()
  };
}

function createGitRepository(root: string) {
  const repository = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repository]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fictional", "-c", "user.email=fictional@example.test", "commit", "--allow-empty", "-m", "Set up fictional repository"]);
  return repository;
}

describe("claude-code launch wiring", () => {
  it("refuses autonomous mode when no durable approval route is configured", async () => {
    await expect(new ClaudeCodeAdapter().run({ participantId: "p", role: "implementer", executable: "claude", model: "sonnet", workingDirectory: process.cwd(), prompt: "hi", options: { permissionMode: "autonomous" } }))
      .rejects.toThrow(/requires a durable permission hook/);
  });

  it("installs the permission hook and never pre-approves a permission mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-tracker-launch-")); tempDirs.push(root);
    const recorder = join(root, "record.sh");
    const argsFile = join(root, "args.txt");
    const settingsCopy = join(root, "settings-copy.json");
    // The adapter deletes the generated settings directory once the process exits, so the copy has
    // to happen from inside the launched process.
    writeFileSync(recorder, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nprev=""\nfor arg in "$@"; do\n  if [ "$prev" = "--settings" ]; then cp "$arg" ${JSON.stringify(settingsCopy)}; fi\n  prev="$arg"\ndone\necho '{"type":"result","session_id":"s","result":"{}"}'\n`, { mode: 0o755 });

    await new ClaudeCodeAdapter().run({ participantId: "participant-fictional", role: "implementer", executable: recorder, model: "sonnet", workingDirectory: root, prompt: "hi", options: { permissionMode: "autonomous" }, permissionHook: { dbPath: join(root, "tracker.db"), runId: "run-fictional" } });

    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args).toContain("--settings");
    // Never acceptEdits or bypassPermissions: the hook grants each call individually.
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    const settings = JSON.parse(readFileSync(settingsCopy, "utf8")) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
    expect(settings.hooks.PreToolUse[0]!.matcher).toMatch(/Write\|Edit/);
  });
});
