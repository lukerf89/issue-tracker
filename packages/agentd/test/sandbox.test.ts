import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addRepository,
  applyMigrations,
  associateRepository,
  claimRunAction,
  completeRunAction,
  createIssue,
  createNodeRepositoryInspector,
  createProject,
  getRun,
  init,
  openDb,
  previewRun,
  resolveRunPermission,
  startRun,
  type ServiceContext
} from "@issue-tracker/core";
import { resolvePermissionHookScript } from "../src/adapters/claude-code.js";
import { runProcess } from "../src/adapters/process.js";
import { buildSeatbeltProfile, resolveToolchainReadPaths, wrapForSandbox } from "../src/sandbox.js";

const tempDirs: string[] = [];
const seatbeltIntegrationAvailable = canApplySeatbelt();
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("provider Seatbelt sandbox", () => {
  it.skipIf(!seatbeltIntegrationAvailable)(
    "denies an ungated out-of-worktree read through runProcess while allowing worktree IO",
    async () => {
      const root = temporaryExternalDirectory();
      const worktree = join(root, "worktree");
      const providerDirectory = join(root, "provider");
      mkdirSync(worktree);
      mkdirSync(providerDirectory);
      const secret = join(root, "host-secret");
      const provider = join(providerDirectory, "provider.sh");
      writeFileSync(secret, "fictional-secret");
      writeFileSync(
        provider,
        `#!/bin/sh\ncat ${JSON.stringify(secret)}\nprintf safe > allowed.txt\ncat allowed.txt\n`,
        { mode: 0o755 }
      );

      const result = await runProcess(provider, [], {
        cwd: worktree,
        sandbox: { worktree, executable: provider, hook: null }
      });

      expect(result.stdout, result.stderr).toBe("safe");
      expect(result.stderr).toMatch(/denied|not permitted|operation not permitted/i);
      expect(readFileSync(join(worktree, "allowed.txt"), "utf8")).toBe("safe");
      expect(result.stdout).not.toContain("fictional-secret");
    }
  );

  it.skipIf(!seatbeltIntegrationAvailable)(
    "runs the real permission hook with DB access without exposing another host file",
    async () => {
      const fixture = setupHookFixture();
      try {
        const hookScriptPath = resolvePermissionHookScript();
        const input = JSON.stringify({
          session_id: "session-fictional",
          tool_name: "Write",
          tool_use_id: "tool-fictional",
          cwd: fixture.worktree,
          tool_input: { file_path: join(fixture.worktree, "GREETING.md"), content: "hi" }
        });
        const approval = setInterval(() => {
          const pending = getRun(fixture.context, fixture.runId).inputRequests.find(
            (candidate) => candidate.state === "pending"
          );
          if (pending)
            resolveRunPermission(fixture.context, {
              run: fixture.runId,
              request: pending.id,
              decision: "approved"
            });
        }, 20);
        let result;
        try {
          result = await runProcess(process.execPath, [hookScriptPath], {
            cwd: fixture.worktree,
            stdin: input,
            env: {
              ...process.env,
              ISSUE_TRACKER_DB: fixture.dbPath,
              ISSUE_TRACKER_RUN_ID: fixture.runId,
              ISSUE_TRACKER_PARTICIPANT_ID: fixture.participantId,
              ISSUE_TRACKER_PERMISSION_POLL_MS: "10"
            },
            sandbox: {
              worktree: fixture.worktree,
              executable: process.execPath,
              hook: { dbPath: fixture.dbPath, hookScriptPath }
            }
          });
        } finally {
          clearInterval(approval);
        }

        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain('"permissionDecision":"allow"');
        expect(getRun(fixture.context, fixture.runId).inputRequests).toHaveLength(1);

        const denied = await runProcess(
          process.execPath,
          [
            "-e",
            `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(fixture.secret)}, "utf8"))`
          ],
          {
            cwd: fixture.worktree,
            sandbox: {
              worktree: fixture.worktree,
              executable: process.execPath,
              hook: { dbPath: fixture.dbPath, hookScriptPath }
            }
          }
        );
        expect(denied.exitCode).not.toBe(0);
        expect(denied.stdout).not.toContain("unrelated-fictional-secret");
      } finally {
        fixture.close();
      }
    }
  );

  it("omits sensitive home paths and includes canonical worktree and hook allowances", () => {
    const root = temporaryExternalDirectory();
    const worktree = join(root, "worktree");
    const control = join(root, "control");
    const installation = join(root, "installation");
    const hook = join(installation, "packages", "agentd", "dist", "permission-hook.js");
    mkdirSync(worktree);
    mkdirSync(control);
    mkdirSync(dirname(hook), { recursive: true });
    mkdirSync(join(installation, "node_modules"));
    writeFileSync(hook, "// fictional hook");
    writeFileSync(join(control, "tracker.db"), "");

    const profile = buildSeatbeltProfile({
      worktree,
      readPaths: resolveToolchainReadPaths(process.execPath),
      writePaths: [],
      hook: { dbPath: join(control, "tracker.db"), hookScriptPath: hook }
    });

    expect(profile).toContain(realpath(worktree));
    expect(profile).toContain(realpath(control));
    expect(profile).toContain(realpath(installation));
    expect(profile).not.toContain(join(homedir(), ".ssh"));
    expect(profile).not.toContain(join(homedir(), ".aws"));
    expect(profile).not.toContain(`(subpath ${JSON.stringify(realpath(homedir()))})`);
  });

  it("returns the provider argv unchanged when Seatbelt is unavailable", () => {
    const wrapped = wrapForSandbox({
      executable: "fictional-provider",
      args: ["--fictional"],
      cwd: process.cwd(),
      sandbox: { worktree: process.cwd(), executable: "fictional-provider", hook: null },
      available: false
    });
    expect(wrapped.executable).toBe("fictional-provider");
    expect(wrapped.args).toEqual(["--fictional"]);
    expect(() => wrapped.cleanup()).not.toThrow();
  });
});

function temporaryExternalDirectory() {
  const directory = mkdtempSync("/private/tmp/tracker-seatbelt-test-");
  tempDirs.push(directory);
  return directory;
}

function canApplySeatbelt() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: "ignore"
    });
    return true;
  } catch {
    // Nested sandboxes (including the Codex test runner) cannot install another Seatbelt profile.
    return false;
  }
}

function realpath(path: string) {
  return realpathSync(path);
}

function setupHookFixture() {
  const root = temporaryExternalDirectory();
  const worktree = join(root, "worktree");
  const control = join(root, "control");
  mkdirSync(control);
  execFileSync("git", ["init", "-b", "main", worktree]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Fictional",
    "-c",
    "user.email=fictional@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "Set up fictional repository"
  ]);
  const dbPath = join(control, "tracker.db");
  const db = openDb(dbPath);
  applyMigrations(db);
  const context: ServiceContext = { db, actor: null, clock: { now: () => new Date() } };
  const initialized = init(context, { teamKey: "ENG", actorHandle: "owner" });
  context.actor = initialized.actor;
  const project = createProject(context, { name: "Fictional Sandbox" });
  const issue = createIssue(context, {
    title: "Confine fictional provider",
    projectId: project.id
  });
  const command = { executable: process.execPath, args: ["-e", "process.exit(0)"], envNames: [] };
  const repository = addRepository(
    context,
    { name: "Primary", path: worktree, testCommand: command, verificationCommand: command },
    createNodeRepositoryInspector()
  );
  associateRepository(context, {
    repository: repository.id,
    project: project.id,
    position: 0,
    isDefault: true,
    overrideKind: "replace"
  });
  const runtime = { inspector: createNodeRepositoryInspector(), dataRoot: join(root, "data") };
  const preview = previewRun(context, { issue: issue.identifier }, runtime);
  const started = startRun(
    context,
    {
      issue: issue.identifier,
      previewFingerprint: preview.previewFingerprint,
      confirmWarnings: preview.warnings
    },
    runtime
  );
  const provision = claimRunAction(context, { supervisorId: "agentd" })!;
  completeRunAction(context, { actionId: provision.id, supervisorId: "agentd", result: {} });
  const participant = getRun(context, started.id).participants.find(
    (candidate) => candidate.role === "planner"
  )!;
  db.$client
    .prepare("update run_participants set state = ?, started_at = ? where id = ?")
    .run("running", context.clock.now().toISOString(), participant.id);
  const secret = join(root, "unrelated-secret");
  writeFileSync(secret, "unrelated-fictional-secret");
  return {
    context,
    runId: started.id,
    participantId: participant.id,
    dbPath,
    worktree,
    secret,
    close: () => db.$client.close()
  };
}
