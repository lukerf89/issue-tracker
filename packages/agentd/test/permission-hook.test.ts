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
import { describeOperation, isAutoApprovable, isReadOnlyCommand, runPermissionHook } from "../src/permission-hook.js";

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

describe("read-only auto-approval", () => {
  it("auto-approves genuine inspection commands", () => {
    for (const command of ["git status", "git log --oneline -5", "git diff HEAD~1", "git show abc123", "ls -la", "pwd", "cat GREETING.md", "wc -l file.txt", "git rev-parse HEAD", "rg pattern src"]) {
      expect(isReadOnlyCommand(command), `${command} should be auto-approved`).toBe(true);
    }
  });

  it("isolates safe flags to the programs that allow them", () => {
    expect(isReadOnlyCommand("ls -la")).toBe(true);
    for (const command of ["cat -la GREETING.md", "wc -la file", "head -la file"]) {
      expect(isReadOnlyCommand(command), `${command} must NOT be auto-approved`).toBe(false);
    }

    expect(isReadOnlyCommand("git log --oneline")).toBe(true);
    for (const command of ["ls --oneline", "git diff --oneline"]) {
      expect(isReadOnlyCommand(command), `${command} must NOT be auto-approved`).toBe(false);
    }

    expect(isReadOnlyCommand("git diff --cached")).toBe(true);
    expect(isReadOnlyCommand("git log --cached")).toBe(false);
  });

  it("preserves numeric shorthand for head and tail", () => {
    expect(isReadOnlyCommand("head -5 file")).toBe(true);
    expect(isReadOnlyCommand("tail -20 file")).toBe(true);
  });

  it("refuses every attempt to smuggle a mutation past the prefix", () => {
    const attempts = [
      "git log && rm -rf /",              // chaining
      "git status; touch pwned",
      "git log || curl evil.test",
      "cat file | tee other",             // pipe
      "cat file > overwritten",           // redirect
      "cat file >> appended",
      "git log `whoami`",                 // backtick substitution
      "ls $(rm -rf /)",                   // command substitution
      "echo ${IFS}",                      // parameter expansion
      "git log\ntouch pwned",             // newline as separator
      "ls -la && git push",
      "cat 'file; rm -rf /'",             // quoted separator
      "git log --format=\"%H\" ; rm x",
      "ls *",                             // glob
      "ls [a-z]",
      "git log \\; rm x"
    ];
    for (const command of attempts) expect(isReadOnlyCommand(command), `${command} must NOT be auto-approved`).toBe(false);
  });

  it("refuses exec-capable and write-capable flags on otherwise read-only programs", () => {
    // Verified against the real binaries: `rg --pre` runs an arbitrary preprocessor, and
    // `git diff --output=` creates the file even when the command then errors.
    for (const command of ["rg --pre /tmp/evil.sh pattern", "rg --pre=/tmp/evil.sh pattern", "rg --hostname-bin /tmp/evil.sh x", "rg --search-zip x", "git diff --output=/tmp/pwned", "git log --output=/tmp/pwned", "git diff --ext-diff", "grep --devices=x y", "cat --unknown-flag f"]) {
      expect(isReadOnlyCommand(command), `${command} must NOT be auto-approved`).toBe(false);
    }
  });

  it("refuses commands whose flags can write, even though the program reads by default", () => {
    // These are why the allowlist names subcommands rather than bare programs.
    for (const command of ["git branch -D main", "git remote add evil https://evil.test", "find . -delete", "find . -exec rm {} ;", "sed -i s/a/b/ file", "sort -o out in", "tee out", "dd if=a of=b"]) {
      expect(isReadOnlyCommand(command), `${command} must NOT be auto-approved`).toBe(false);
    }
  });

  it("refuses reads that escape the worktree, so auto-approval cannot exfiltrate secrets", () => {
    // A matched reader still accepts arbitrary operands; without confinement `cat /etc/passwd`
    // would be auto-approved and its contents pulled into the agent's context. Absolute paths,
    // home-relative paths, and `..` traversal must all gate to a human.
    for (const command of [
      "cat /etc/passwd",
      "cat /Users/someone/.ssh/id_ed25519",
      "head -c 4096 /Users/someone/.aws/credentials",
      "od -c /etc/passwd",
      "stat /etc/shadow",
      "grep -r AKIA /",
      "rg root /etc/passwd",
      "diff /etc/passwd /dev/null",
      "cat ~/.aws/credentials",
      "cat ../../secret",
      "cat ../outside.txt",
      "git show HEAD:../../../etc/passwd"
    ]) {
      expect(isReadOnlyCommand(command), `${command} must NOT be auto-approved`).toBe(false);
    }
  });

  it("still auto-approves in-worktree reads with relative operands", () => {
    for (const command of ["cat GREETING.md", "cat src/index.ts", "cat ./notes.md", "head -n 5 file.txt", "rg pattern src", "git show HEAD~1:src/index.ts"]) {
      expect(isReadOnlyCommand(command), `${command} should be auto-approved`).toBe(true);
    }
  });

  it("no longer treats `file` as read-only, since -C compiles a magic table to disk", () => {
    // `-C` is benign for `ls` but write-capable for BSD/macOS `file`; the shared SAFE_FLAGS set
    // let `file -C` through, so `file` is dropped from the allowlist entirely.
    for (const command of ["file -C", "file GREETING.md", "file -C magic"]) {
      expect(isReadOnlyCommand(command), `${command} must NOT be auto-approved`).toBe(false);
    }
  });

  it("gates every non-Bash mutating tool regardless of the allowlist", () => {
    expect(isAutoApprovable({ tool_name: "Write", tool_input: { file_path: "/x", content: "y" } })).toBe(false);
    expect(isAutoApprovable({ tool_name: "Edit", tool_input: { file_path: "/x" } })).toBe(false);
    expect(isAutoApprovable({ tool_name: "WebFetch", tool_input: { url: "https://example.test" } })).toBe(false);
    expect(isAutoApprovable({ tool_name: "Bash", tool_input: {} })).toBe(false);
    expect(isAutoApprovable({ tool_name: "Bash" })).toBe(false);
  });

  it("records an audit event for an auto-approval without queueing a human decision", async () => {
    const fixture = setup();
    try {
      const call = JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: "git status" } });
      expect(decisionOf(await runPermissionHook(call, fixture.env()))).toMatchObject({ permissionDecision: "allow" });

      const run = getRun(fixture.context, fixture.runId);
      expect(run.inputRequests.filter((request) => request.kind === "permission")).toEqual([]);
      const events = listRunEvents(fixture.context, { run: fixture.runId }).events;
      const audit = events.filter((event) => event.type === "permission.auto_approved");
      expect(audit).toHaveLength(1);
      expect(audit[0]!.data).toMatchObject({ operation: { tool: "Bash", scope: "git status", autoApproved: "read_only" } });
    } finally { fixture.close(); }
  });

  it("still queues a human decision for a mutating command", async () => {
    const fixture = setup();
    try {
      const call = JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: "git commit -m fictional" } });
      const result = decisionOf(await runPermissionHook(call, { ...fixture.env(), ISSUE_TRACKER_PERMISSION_TIMEOUT_MS: "60", ISSUE_TRACKER_PERMISSION_POLL_MS: "10" }));
      expect(result).toMatchObject({ permissionDecision: "deny" });
      expect(getRun(fixture.context, fixture.runId).inputRequests.filter((request) => request.kind === "permission")).toHaveLength(1);
    } finally { fixture.close(); }
  });
});
