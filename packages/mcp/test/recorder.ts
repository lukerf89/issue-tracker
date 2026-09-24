import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { ContractFixture, ToolCall } from "./contract-fixture.js";

/**
 * Per-call workload metrics, recorded separately (LF-145):
 * - textBytes: UTF-8 bytes of the text content block (what a text-only client reads);
 * - structuredBytes: UTF-8 bytes of JSON.stringify(structuredContent), or 0;
 * - combinedPayloadBytes: text + structured logical payloads (structured tools duplicate the
 *   payload; this is NOT the wire size);
 * - jsonRpcBytes: the server-to-client JSON-RPC envelope bytes actually sent for this call (the
 *   in-memory transport; stdio would add one newline per message);
 * - latencyMs: wall-clock time, recorded for the report only and never asserted.
 * Tokens are not measured: no tokenizer is involved anywhere in this harness.
 */
export interface CallRecord {
  phase: string;
  step: number;
  tool: string;
  ok: boolean;
  textBytes: number;
  structuredBytes: number;
  combinedPayloadBytes: number;
  jsonRpcBytes: number;
  latencyMs: number;
}

export interface PhaseTotals {
  toolCalls: number;
  textBytes: number;
  structuredBytes: number;
  combinedPayloadBytes: number;
  jsonRpcBytes: number;
  latencyMs: number;
  correct: boolean | null;
}

const utf8 = (value: string) => Buffer.byteLength(value);

export class Recorder {
  readonly calls: CallRecord[] = [];
  readonly phases: Record<string, PhaseTotals> = {};

  record(phase: string, record: Omit<CallRecord, "phase" | "step" | "combinedPayloadBytes">): CallRecord {
    const totals = this.phases[phase] ??= { toolCalls: 0, textBytes: 0, structuredBytes: 0, combinedPayloadBytes: 0, jsonRpcBytes: 0, latencyMs: 0, correct: null };
    const full: CallRecord = { phase, step: totals.toolCalls + 1, ...record, combinedPayloadBytes: record.textBytes + record.structuredBytes };
    totals.toolCalls += 1;
    totals.textBytes += full.textBytes;
    totals.structuredBytes += full.structuredBytes;
    totals.combinedPayloadBytes += full.combinedPayloadBytes;
    totals.jsonRpcBytes += full.jsonRpcBytes;
    totals.latencyMs += full.latencyMs;
    this.calls.push(full);
    return full;
  }

  /** Marks a phase's correctness once all of its assertions have passed (or failed). */
  correct(phase: string, value: boolean) {
    (this.phases[phase] ??= { toolCalls: 0, textBytes: 0, structuredBytes: 0, combinedPayloadBytes: 0, jsonRpcBytes: 0, latencyMs: 0, correct: null }).correct = value;
  }

  /** A recording agent: every tool call and catalog listing through it is measured under `phase`. */
  agent(f: ContractFixture, client: Client, phase: string) {
    const call = async (name: string, args: Record<string, unknown>): Promise<ToolCall & { metrics: CallRecord }> => {
      const before = f.jsonRpcBytes(client);
      const started = performance.now();
      const result = await f.call(client, name, args);
      const latencyMs = performance.now() - started;
      const metrics = this.record(phase, {
        tool: name,
        ok: !result.isError,
        textBytes: utf8(result.text),
        structuredBytes: result.structuredContent === undefined ? 0 : utf8(JSON.stringify(result.structuredContent)),
        jsonRpcBytes: f.jsonRpcBytes(client) - before,
        latencyMs
      });
      return { ...result, metrics };
    };
    const listTools = async () => {
      const before = f.jsonRpcBytes(client);
      const started = performance.now();
      const result = await client.listTools();
      const latencyMs = performance.now() - started;
      const metrics = this.record(phase, {
        tool: "tools/list",
        ok: true,
        textBytes: utf8(JSON.stringify({ tools: result.tools })),
        structuredBytes: 0,
        jsonRpcBytes: f.jsonRpcBytes(client) - before,
        latencyMs
      });
      return { tools: result.tools, metrics };
    };
    return { call, listTools };
  }

  /** Writes the report when WORKLOAD_REPORT names a file (opt-in; never read by the tests). */
  report() {
    if (!process.env.WORKLOAD_REPORT) return;
    writeFileSync(process.env.WORKLOAD_REPORT, JSON.stringify({
      units: {
        textBytes: "utf8 bytes of the text content block",
        structuredBytes: "utf8 bytes of JSON.stringify(structuredContent)",
        combinedPayloadBytes: "textBytes + structuredBytes (logical payloads; not wire size)",
        jsonRpcBytes: "server-to-client JSON-RPC envelope bytes (in-memory transport; no stdio newline)",
        latencyMs: "wall clock; informational, never asserted",
        tokens: "not measured"
      },
      phases: this.phases,
      calls: this.calls
    }, null, 2));
  }
}
