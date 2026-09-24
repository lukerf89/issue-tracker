/**
 * LF-145 context budgets: the single source of truth for the CI ceilings asserted by
 * agent-workflow-budget.test.ts and tool-catalog-size.test.ts. Units are UTF-8 bytes (never
 * tokens). Each ceiling is the harness value measured at origin/main e3bd0a4 plus about 20–25%,
 * rounded; a structuredBytes ceiling of 0 pins a text-only response. Provenance per entry:
 *   audit  = the September 2026 audit baseline quoted in LF-145 (different fictional data);
 *   66ce9db = this harness's portable probe at the pre-batch commit (LF-132);
 *   e3bd0a4 = this harness at origin/main after LF-137..LF-144.
 * See BUDGETS.md for definitions and how to regenerate. Raise a ceiling only deliberately, in
 * the same change that explains why the payload grew.
 */
export const BUDGETS = {
  catalog: {
    // audit 34 tools / 18,234 B; 66ce9db 18 / 24,426 B; e3bd0a4 20 / 35,052 B.
    coding: { tools: 24, bytes: 43_000 },
    // audit 70 tools / 39,138 B; 66ce9db 74 / 56,850 B; e3bd0a4 77 / 95,760 B (the 128 KiB gate stays too).
    full: { tools: 92, bytes: 118_000 }
  },

  /** tool-catalog-size.test.ts responses on the small contract fixture (e3bd0a4 text/structured). */
  responses: {
    list_issues: { textBytes: 1_150, structuredBytes: 1_150 }, // 924 / 924
    search: { textBytes: 1_400, structuredBytes: 1_400 }, // 1,138 / 1,138
    "update_issue compact": { textBytes: 175, structuredBytes: 175 }, // 140 / 140
    "update_issue full": { textBytes: 950, structuredBytes: 950 }, // 760 / 760
    get_issue: { textBytes: 1_850, structuredBytes: 0 }, // 1,485 / text-only
    get_work_context: { textBytes: 4_350, structuredBytes: 0 } // 3,492 / text-only
  },

  /** Single calls on the heavy workload fixture. */
  calls: {
    // audit 9,212; 66ce9db 9,771 text (no structured); e3bd0a4 9,769 / 9,769.
    listIssuesDefaultPage: { textBytes: 12_000, structuredBytes: 12_000 },
    // audit 1,149; 66ce9db 1,451 text; e3bd0a4 1,451 / 1,451.
    search5: { textBytes: 1_800, structuredBytes: 1_800 },
    // audit 55,195; 66ce9db 68,261; e3bd0a4 68,261 / text-only (40 KB body + latest 10 comments).
    getIssueVerbose: { textBytes: 82_000, structuredBytes: 0 },
    // audit n/a (compact did not exist); 66ce9db 142 text; e3bd0a4 141 / 141.
    updatePriorityCompact: { textBytes: 175, structuredBytes: 175 },
    // audit 55,195; 66ce9db 68,261 text; e3bd0a4 68,261 / 68,261 (full issue echoed in both blocks).
    updatePriorityFull: { textBytes: 82_000, structuredBytes: 82_000 },
    // audit n/a; 66ce9db unavailable (tool absent); e3bd0a4 16,440 / text-only (16,384-byte payload budget + envelope).
    workContextDefault: { textBytes: 19_700, structuredBytes: 0 }
  },

  /**
   * Whole phases on the heavy workload fixture (e3bd0a4 only: 66ce9db lacks get_work_context,
   * paged list_activity and structured output, so the phases cannot run there).
   * e3bd0a4 measurements, as toolCalls / combinedPayloadBytes / jsonRpcBytes:
   */
  phases: {
    discovery: { toolCalls: 5, combinedPayloadBytes: 163_000, jsonRpcBytes: 164_000 }, // 4 / 135,575 / 136,444
    actionable: { toolCalls: 15, combinedPayloadBytes: 70_000, jsonRpcBytes: 75_000 }, // 12 / 57,872 / 61,859
    requirements: { toolCalls: 62, combinedPayloadBytes: 268_000, jsonRpcBytes: 277_000 }, // 49 / 222,791 / 230,326
    claim: { toolCalls: 4, combinedPayloadBytes: 2_500, jsonRpcBytes: 3_000 }, // 3 / 2,038 / 2,440
    update: { toolCalls: 10, combinedPayloadBytes: 175_000, jsonRpcBytes: 178_000 }, // 8 / 145,455 / 147,623
    recovery: { toolCalls: 13, combinedPayloadBytes: 23_000, jsonRpcBytes: 26_500 }, // 10 / 18,611 / 21,388
    concurrent: { toolCalls: 34, combinedPayloadBytes: 223_000, jsonRpcBytes: 237_000 }, // 27 / 185,026 / 196,762
    parity: { toolCalls: 3, combinedPayloadBytes: 37_500, jsonRpcBytes: 39_500 } // 2 / 31,124 / 32,651
  }
} as const;
