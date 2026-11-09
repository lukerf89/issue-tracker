import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function recorder(exitCode = 0, stderr = "") {
  const root = mkdtempSync(join(tmpdir(), "issue-tracker-probe-")); tempDirs.push(root);
  const script = join(root, "record.sh");
  const argsFile = join(root, "args.txt");
  const cwdFile = join(root, "cwd.txt");
  writeFileSync(script, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\npwd -P > ${JSON.stringify(cwdFile)}\n${stderr ? `echo ${JSON.stringify(stderr)} >&2\n` : ""}exit ${exitCode}\n`, { mode: 0o755 });
  return { script, args: () => readFileSync(argsFile, "utf8").split("\n"), cwd: () => readFileSync(cwdFile, "utf8").trim() };
}

describe("claude-code health probe", () => {
  it("runs isolated: no MCP servers, settings, slash commands, tools, or default system prompt", async () => {
    const run = recorder();
    const health = await new ClaudeCodeAdapter().probe({ executable: run.script, model: "sonnet", options: {}, env: {} });
    expect(health).toMatchObject({ installed: true, authenticated: true, modelAccessible: true, diagnosticCode: null });

    const args = run.args();
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--disable-slash-commands");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--system-prompt");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args).toContain("--json-schema");
  });

  it("runs from a throwaway empty directory that is removed afterwards", async () => {
    const run = recorder();
    await new ClaudeCodeAdapter().probe({ executable: run.script, model: "sonnet", options: {}, env: {} });
    expect(run.cwd()).not.toBe(process.cwd());
    expect(run.cwd()).toMatch(/tracker-probe-/);
    expect(existsSync(run.cwd())).toBe(false);
  });

  it("still classifies authentication and model failures", async () => {
    const auth = await new ClaudeCodeAdapter().probe({ executable: recorder(1, "OAuth token expired").script, model: "sonnet", options: {}, env: {} });
    expect(auth).toMatchObject({ authenticated: false, diagnosticCode: "provider_authentication_failed" });

    const model = await new ClaudeCodeAdapter().probe({ executable: recorder(1, "model claude-x not found").script, model: "claude-x", options: {}, env: {} });
    expect(model).toMatchObject({ authenticated: true, modelAccessible: false, diagnosticCode: "provider_model_unavailable" });
  });
});
