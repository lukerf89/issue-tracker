import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import * as sandboxModule from "../../src/sandbox.js";

const tempDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("provider OS sandbox adapter wiring", () => {
  it("threads an enabled Claude Code sandbox through runProcess to the spawn wrapper", async () => {
    const calls: Parameters<typeof sandboxModule.wrapForSandbox>[0][] = [];
    vi.spyOn(sandboxModule, "wrapForSandbox").mockImplementation((input) => {
      calls.push(input);
      return {
        executable: input.executable,
        args: input.args,
        cleanup: () => {}
      };
    });
    const launch = launchFixture({ osSandbox: true });

    await new ClaudeCodeAdapter().run(launch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: launch.executable,
      sandbox: {
        worktree: launch.workingDirectory,
        executable: launch.executable
      }
    });
  });

  it.each([[false], [undefined]])(
    "does not wrap a Claude Code spawn when osSandbox is %s",
    async (osSandbox) => {
      const calls: Parameters<typeof sandboxModule.wrapForSandbox>[0][] = [];
      vi.spyOn(sandboxModule, "wrapForSandbox").mockImplementation((input) => {
        calls.push(input);
        return {
          executable: input.executable,
          args: input.args,
          cleanup: () => {}
        };
      });
      const launch = launchFixture(osSandbox === undefined ? undefined : { osSandbox });

      await new ClaudeCodeAdapter().run(launch);

      expect(calls).toHaveLength(0);
    }
  );

  it("does not wrap a Codex spawn when osSandbox is enabled", async () => {
    const calls: Parameters<typeof sandboxModule.wrapForSandbox>[0][] = [];
    vi.spyOn(sandboxModule, "wrapForSandbox").mockImplementation((input) => {
      calls.push(input);
      return {
        executable: input.executable,
        args: input.args,
        cleanup: () => {}
      };
    });
    const launch = launchFixture({ osSandbox: true }, "codex");

    await new CodexAdapter().run(launch);

    expect(calls).toHaveLength(0);
  });
});

function launchFixture(
  options?: Record<string, unknown>,
  provider: "claude-code" | "codex" = "claude-code"
) {
  const directory = mkdtempSync(join(tmpdir(), "tracker-sandbox-wiring-"));
  tempDirectories.push(directory);
  const executable = join(directory, "provider");
  const event =
    provider === "codex"
      ? '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'
      : '{"type":"result","result":"{}"}';
  writeFileSync(executable, `#!/bin/sh\necho '${event}'\n`);
  chmodSync(executable, 0o700);
  return {
    participantId: "fictional",
    role: "implementer",
    executable,
    model: "fictional-model",
    workingDirectory: directory,
    prompt: "Fictional prompt",
    permissionHook: null,
    options
  };
}
