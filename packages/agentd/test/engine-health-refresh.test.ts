import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { addProfile, applyMigrations, archiveProfile, init, openDb, type Clock, type EngineDefinition, type ServiceContext } from "@issue-tracker/core";
import { FakeProviderAdapter } from "../src/adapters/fake.js";
import { Supervisor } from "../src/supervisor.js";

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const HOUR = 60 * 60_000;
const capabilities = { resume: true, redirect: true, interactivePermissions: true, structuredOutput: true, childParticipants: false, usage: true };
const engine: EngineDefinition = { adapter: "fake", executable: "fixture", model: "fictional-model", permissionMode: "autonomous", envNames: [], capabilities };

function mutableClock(iso: string): Clock & { advance(milliseconds: number): void } {
  let current = new Date(iso).getTime();
  return { now: () => new Date(current), advance: (milliseconds) => { current += milliseconds; } };
}

function setup(options: { healthy?: boolean; engineHealthTtlMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "issue-tracker-health-")); tempDirs.push(root);
  const db = openDb(join(root, "tracker.db")); applyMigrations(db);
  const clock = mutableClock("2026-07-17T12:00:00.000Z");
  const context: ServiceContext = { db, actor: null, clock };
  context.actor = init(context, { teamKey: "ENG", actorHandle: "owner" }).actor;
  const fake = new FakeProviderAdapter([]);
  let probes = 0;
  fake.probe = async () => { probes += 1; return options.healthy === false ? { installed: true, authenticated: false, modelAccessible: false, diagnosticCode: "provider_authentication_failed", remediation: "Authenticate." } : { installed: true, authenticated: true, modelAccessible: true, diagnosticCode: null, remediation: null }; };
  const supervisor = new Supervisor({ id: "health-agentd", context, dataRoot: join(root, "data"), adapters: { fake }, engines: { "claude-default": engine }, engineHealthTtlMs: options.engineHealthTtlMs });
  return { clock, context, supervisor, probes: () => probes, close: () => db.$client.close() };
}

function roles(engineName: string) {
  return Object.fromEntries(["orchestrator", "planner", "implementer", "verifier", "bindingReviewer", "adversarialReviewer"].map((role) => [role, engineName]));
}

describe("engine health refresh", () => {
  it("probes once, then stays quiet while idle until the TTL lapses", async () => {
    const fixture = setup();
    try {
      for (let index = 0; index < 5; index += 1) await fixture.supervisor.runOnce();
      expect(fixture.probes()).toBe(1);
      fixture.clock.advance(5 * HOUR);
      for (let index = 0; index < 5; index += 1) await fixture.supervisor.runOnce();
      expect(fixture.probes()).toBe(1);
      fixture.clock.advance(HOUR + 60_000);
      await fixture.supervisor.runOnce();
      expect(fixture.probes()).toBe(2);
    } finally { fixture.close(); }
  });

  it("re-probes an unhealthy engine after 15 minutes instead of waiting out the full TTL", async () => {
    const fixture = setup({ healthy: false });
    try {
      await fixture.supervisor.runOnce();
      fixture.clock.advance(14 * 60_000);
      await fixture.supervisor.runOnce();
      expect(fixture.probes()).toBe(1);
      fixture.clock.advance(2 * 60_000);
      await fixture.supervisor.runOnce();
      expect(fixture.probes()).toBe(2);
    } finally { fixture.close(); }
  });

  it("honours an explicit engineHealthTtlMs", async () => {
    const fixture = setup({ engineHealthTtlMs: 30 * 60_000 });
    try {
      await fixture.supervisor.runOnce();
      fixture.clock.advance(31 * 60_000);
      await fixture.supervisor.runOnce();
      expect(fixture.probes()).toBe(2);
    } finally { fixture.close(); }
  });

  it("does not probe engines that no live profile references", async () => {
    const fixture = setup();
    const probed: string[] = [];
    try {
      // The built-in profile references claude-default only; archived profiles must not count.
      const archived = addProfile(fixture.context, { name: "overnight-opus", workflow: "issue-delivery", configuration: { roles: roles("claude-opus"), permissionPolicy: "prompt", pushPolicy: "approved", draftPrPolicy: "approved", issueStartedState: "__started__" }, isDefault: false });
      archiveProfile(fixture.context, archived.id);
      const unused: EngineDefinition = { ...engine, model: "fictional-opus" };
      const fake = new FakeProviderAdapter([]);
      fake.probe = async () => { probed.push("probe"); return { installed: true, authenticated: true, modelAccessible: true, diagnosticCode: null, remediation: null }; };
      const supervisor = new Supervisor({ id: "unused-agentd", context: fixture.context, dataRoot: join(tmpdir(), "unused-data"), adapters: { fake }, engines: { "claude-default": engine, "claude-opus": unused } });
      await supervisor.runOnce();
      expect(probed).toHaveLength(1);
    } finally { fixture.close(); }
  });

  it("probes an engine as soon as a profile starts referencing it", async () => {
    const fixture = setup();
    const probed: string[] = [];
    try {
      const fake = new FakeProviderAdapter([]);
      fake.probe = async () => { probed.push("probe"); return { installed: true, authenticated: true, modelAccessible: true, diagnosticCode: null, remediation: null }; };
      const supervisor = new Supervisor({ id: "late-agentd", context: fixture.context, dataRoot: join(tmpdir(), "late-data"), adapters: { fake }, engines: { "claude-default": engine, "claude-opus": { ...engine, model: "fictional-opus" } } });
      await supervisor.runOnce();
      expect(probed).toHaveLength(1);
      addProfile(fixture.context, { name: "opus-now", workflow: "issue-delivery", configuration: { roles: roles("claude-opus"), permissionPolicy: "prompt", pushPolicy: "approved", draftPrPolicy: "approved", issueStartedState: "__started__" }, isDefault: false });
      await supervisor.runOnce();
      expect(probed).toHaveLength(2);
    } finally { fixture.close(); }
  });
});
