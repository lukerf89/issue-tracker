import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE_HEALTH_TTL_MS, FAILED_ENGINE_HEALTH_TTL_MS, engineHealthFresh, resolveEngineHealthTtlMs, type EngineHealthSnapshot } from "../src/index.js";

const healthy: EngineHealthSnapshot = { engineName: "fictional", fingerprint: "f".repeat(16), installed: true, authenticated: true, modelAccessible: true, diagnosticCode: null, remediation: null, checkedAt: "2026-07-17T00:00:00.000Z" };
const failed: EngineHealthSnapshot = { ...healthy, authenticated: false, diagnosticCode: "provider_authentication_failed", remediation: "Authenticate." };
const after = (milliseconds: number) => new Date(Date.parse(healthy.checkedAt) + milliseconds);

describe("engine health TTL", () => {
  it("defaults to hours, not minutes, because every probe is a model call", () => {
    expect(DEFAULT_ENGINE_HEALTH_TTL_MS).toBe(6 * 60 * 60_000);
    expect(resolveEngineHealthTtlMs({})).toBe(DEFAULT_ENGINE_HEALTH_TTL_MS);
  });

  it("honours ISSUE_TRACKER_ENGINE_HEALTH_TTL_MS and ignores invalid values", () => {
    expect(resolveEngineHealthTtlMs({ ISSUE_TRACKER_ENGINE_HEALTH_TTL_MS: "60000" })).toBe(60_000);
    for (const bad of ["0", "-5", "abc", "1.5", ""]) expect(resolveEngineHealthTtlMs({ ISSUE_TRACKER_ENGINE_HEALTH_TTL_MS: bad })).toBe(DEFAULT_ENGINE_HEALTH_TTL_MS);
  });

  it("trusts healthy evidence for the full TTL", () => {
    expect(engineHealthFresh(healthy, after(DEFAULT_ENGINE_HEALTH_TTL_MS), DEFAULT_ENGINE_HEALTH_TTL_MS)).toBe(true);
    expect(engineHealthFresh(healthy, after(DEFAULT_ENGINE_HEALTH_TTL_MS + 1), DEFAULT_ENGINE_HEALTH_TTL_MS)).toBe(false);
    expect(engineHealthFresh(null, after(0), DEFAULT_ENGINE_HEALTH_TTL_MS)).toBe(false);
  });

  it("re-probes unhealthy engines after the short failure TTL", () => {
    expect(engineHealthFresh(failed, after(FAILED_ENGINE_HEALTH_TTL_MS), DEFAULT_ENGINE_HEALTH_TTL_MS)).toBe(true);
    expect(engineHealthFresh(failed, after(FAILED_ENGINE_HEALTH_TTL_MS + 1), DEFAULT_ENGINE_HEALTH_TTL_MS)).toBe(false);
    expect(engineHealthFresh(failed, after(2_000), 1_000)).toBe(false);
  });
});
