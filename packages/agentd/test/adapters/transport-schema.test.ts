import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
