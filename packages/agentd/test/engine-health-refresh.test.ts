import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDb, type Clock, type EngineDefinition, type ServiceContext } from "@issue-tracker/core";
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
  const fake = new FakeProviderAdapter([]);
  let probes = 0;
  fake.probe = async () => { probes += 1; return options.healthy === false ? { installed: true, authenticated: false, modelAccessible: false, diagnosticCode: "provider_authentication_failed", remediation: "Authenticate." } : { installed: true, authenticated: true, modelAccessible: true, diagnosticCode: null, remediation: null }; };
  const supervisor = new Supervisor({ id: "health-agentd", context, dataRoot: join(root, "data"), adapters: { fake }, engines: { "claude-default": engine }, engineHealthTtlMs: options.engineHealthTtlMs });
  return { clock, supervisor, probes: () => probes, close: () => db.$client.close() };
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
});
