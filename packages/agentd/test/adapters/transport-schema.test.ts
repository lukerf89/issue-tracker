import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { participantResultSchema } from "@issue-tracker/core";

import { participantResultOutputSchema } from "../../src/adapters/contract.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";
import { CodexAdapter } from "../../src/adapters/codex.js";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("provider participant-result transport schemas", () => {
  it("omits the unsupported Claude draft declaration and preserves optional nullable findings", () => {
    const schema = participantResultOutputSchema("claude-code", "implementer");
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).not.toHaveProperty("properties.risk");
    expect(schema).not.toHaveProperty("properties.estimatedSize");
    expect(schema).toMatchObject({ required: expect.not.arrayContaining(["risk", "estimatedSize"]) });
    expect(schema).toMatchObject({ properties: { findings: { items: { required: ["severity", "summary", "evidence"] } } } });
  });

  it("makes every Codex object strict and every property required recursively", () => {
    const schema = participantResultOutputSchema("codex", "planner");
    assertStrict(schema);
    expect(schema).toMatchObject({ required: expect.arrayContaining(["risk", "estimatedSize"]) });
    expect(schema).toMatchObject({ properties: { findings: { items: { required: expect.arrayContaining(["file", "location"]) } } } });
  });

  it.each(["planner", "implementer", "bindingReviewer"])("round-trips a %s result through transport semantics and the canonical schema", (role) => {
    const result = { role, summary: "Fictional result", files: [], tests: [], risks: [], findings: [{ severity: "info", file: null, location: null, summary: "Fictional finding", evidence: "Fixture evidence" }], verifiedTestsPassed: true, riskNotes: [], ...(role === "planner" ? { risk: "low", estimatedSize: "small" } : {}) };
    expect(participantResultSchema.safeParse(result).success).toBe(true);
    const schema = participantResultOutputSchema("codex", role);
    expect(Object.keys(result).sort()).toEqual((schema.required as string[]).sort());
  });

  it("keeps planner fields mandatory in the canonical contract", () => {
    expect(participantResultSchema.safeParse({ role: "planner", summary: "Fictional result", files: [], tests: [], risks: [], findings: [], verifiedTestsPassed: true, riskNotes: [] }).success).toBe(false);
  });

  it.each([["claude-code", new ClaudeCodeAdapter()], ["codex", new CodexAdapter()]] as const)("keeps actualModel null and normalizes a pre-inference %s schema rejection", async (_name, adapter) => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-provider-fixture-")); tempDirectories.push(directory);
    const executable = join(directory, "provider");
    writeFileSync(executable, "#!/bin/sh\necho 'structured output schema invalid' >&2\nexit 1\n"); chmodSync(executable, 0o700);
    const result = await adapter.run({ participantId: "fictional", role: "implementer", executable, model: "requested-fictional-model", workingDirectory: directory, prompt: "Fictional prompt" });
    expect(result).toMatchObject({ exitCode: 1, actualModel: null, structuredResult: null, failure: { code: "provider_schema_rejected" } });
  });

  it.each([
    ["claude-code", new ClaudeCodeAdapter(), "{\"type\":\"result\",\"result\":\"{}\"}"],
    ["codex", new CodexAdapter(), "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{}\"}}"]
  ] as const)("normalizes an invalid successful %s response", async (_name, adapter, line) => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-provider-fixture-")); tempDirectories.push(directory);
    const executable = join(directory, "provider");
    writeFileSync(executable, `#!/bin/sh\necho '${line}'\n`); chmodSync(executable, 0o700);
    const result = await adapter.run({ participantId: "fictional", role: "implementer", executable, model: "requested-fictional-model", workingDirectory: directory, prompt: "Fictional prompt" });
    expect(result).toMatchObject({ exitCode: 0, actualModel: null, structuredResult: null, failure: { code: "provider_result_invalid" } });
  });

  it("re-asserts the operator sandbox on resume, since `codex exec resume` reverts to the config default otherwise", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-codex-args-")); tempDirectories.push(directory);
    const executable = join(directory, "provider");
    const argsFile = join(directory, "args.txt");
    // Record argv, then emit a minimal valid stream so the adapter parses without error.
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'\n`); chmodSync(executable, 0o700);
    const launch = { participantId: "fictional", role: "implementer", executable, model: "m", workingDirectory: directory, prompt: "Fictional prompt", options: { sandbox: "read-only" } };

    await new CodexAdapter().run(launch);
    const initial = readFileSync(argsFile, "utf8").split("\n");
    // First turn confines with the native flag.
    expect(initial).toContain("--sandbox");
    expect(initial[initial.indexOf("--sandbox") + 1]).toBe("read-only");

    await new CodexAdapter().resume(launch, "session-1");
    const resumed = readFileSync(argsFile, "utf8").split("\n");
    // Resume rejects --sandbox, so the sandbox must ride in as a config override — never dropped.
    expect(resumed).not.toContain("--sandbox");
    expect(resumed).toContain("sandbox_mode=read-only");
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "session-1"]);
  });

  it("forwards workspace-write extra writable roots on initial and resumed Codex turns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tracker-codex-args-")); tempDirectories.push(directory);
    const executable = join(directory, "provider");
    const argsFile = join(directory, "args.txt");
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}'\n`); chmodSync(executable, 0o700);
    const launch = { participantId: "fictional", role: "implementer", executable, model: "m", workingDirectory: directory, prompt: "Fictional prompt", options: { sandbox: "workspace-write", writableRoots: ["/tmp/root-a", "/tmp/root-b"] } };

    await new CodexAdapter().run(launch);
    const initial = readFileSync(argsFile, "utf8").split("\n");
    expect(initial.filter((arg) => arg === "--add-dir")).toHaveLength(2);
    for (const root of launch.options.writableRoots) expect(initial[initial.indexOf(root) - 1]).toBe("--add-dir");

    await new CodexAdapter().resume(launch, "session-1");
    const resumed = readFileSync(argsFile, "utf8").split("\n");
    expect(resumed).not.toContain("--add-dir");
    const writableRootsConfig = 'sandbox_workspace_write.writable_roots=["/tmp/root-a","/tmp/root-b"]';
    expect(resumed).toContain("--config");
    expect(resumed[resumed.indexOf(writableRootsConfig) - 1]).toBe("--config");
    expect(resumed).toContain("sandbox_mode=workspace-write");
  });
});

function assertStrict(schema: Record<string, unknown>) {
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(properties));
    for (const child of Object.values(properties)) assertStrict(child);
  }
  if (schema.items && typeof schema.items === "object") assertStrict(schema.items as Record<string, unknown>);
  if (Array.isArray(schema.anyOf)) for (const child of schema.anyOf) assertStrict(child as Record<string, unknown>);
}
