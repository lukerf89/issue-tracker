# Agent context budgets (LF-145)

These tests check that agent-facing payloads stay small and that no traversal silently drops work.
They run on fictional data only. The ceilings live in [`budgets.ts`](budgets.ts), and
this file explains where the numbers come from.

- [`agent-workflow-budget.test.ts`](agent-workflow-budget.test.ts) runs eight end-to-end agent
  phases on a heavy fixture (`contractFixture({ workload: true })`, seeded by
  [`workload-seed.ts`](workload-seed.ts)). Each phase gets its own fresh fixture, checks
  correctness first, then checks its per-call and per-phase ceilings.
- [`tool-catalog-size.test.ts`](tool-catalog-size.test.ts) keeps its existing gates: full catalog
  under 128 KiB, and contracts adding less than 70%. It also checks the per-profile catalog and
  per-response ceilings.

## Metrics

Every metric is recorded separately, per call and per phase. See [`recorder.ts`](recorder.ts).

| Metric | Definition |
| --- | --- |
| `textBytes` | UTF-8 bytes of the text content block. This is what a text-only MCP client reads. |
| `structuredBytes` | UTF-8 bytes of `JSON.stringify(structuredContent)`, or 0 for text-only tools. |
| `combinedPayloadBytes` | `textBytes + structuredBytes`. These are logical payloads, not the wire size. Structured tools send the same payload twice. |
| `jsonRpcBytes` | The server-to-client JSON-RPC envelope bytes actually sent for the call. It is counted by wrapping the in-memory transport's `send`. Stdio adds one newline per message, which is not counted here. |
| `toolCalls` | The number of `tools/call` and `tools/list` requests in a phase. |
| `latencyMs` | Wall-clock time. It is recorded in the report only and is **never asserted**. |
| tokens | **Not measured.** No tokenizer is used, so every number here is bytes. |

## Workload

The workload is fictional and deterministic. It is seeded through the core barrel on its own
advancing clock, so the byte counts are reproducible run to run. It adds these on top of the
contract seed (ENG-1..ENG-5, repositories and a started run):

- 60 workload tasks with mixed states and priorities. Every fourth task is assigned to the human, and four are archived.
- A requirements issue with a ~40 KB multi-section body, a 12-item `Done when:` list and thirty ~2 KB comments.
- A hub issue with 8 children, 7 blockers and 7 dependants, plus 12 labels and 5 link attachments.
- On the requirements issue: a parent with a ~2.5 KB description, 6 open blockers and a
  2-repository routing override (Primary, Secondary). These are created after the hub, so they
  don't change any earlier identifier. They give its work context populated `blockers`, `parent`
  and `repositories` sections.
- 50 appended events on the seeded run.

## Phases

| Phase | Correctness checked |
| --- | --- |
| discovery | `whoami` and `describe`. The `full` and `coding` catalogs are both listed. `coding` is a strict subset that still covers the agent loop. |
| actionable | `list_issues` is walked page by page, once with `stateTypes`+`assignee:null` and once with `builtin:unassigned`. The result must equal the claimable set read from the records, in order, with no duplicates. Also checks the default 50-row page and 5 search results. |
| requirements | `get_work_context` must stay within its budget and return the complete acceptance criteria. The complete-content path rebuilds the body and all 30 comments byte for byte through `read_issue_section`, and returns every hub relation. What the context left out is then computed from that complete content (body characters, whole comments, comment-body characters, blockers, parent and its excerpt) and from the seeded repository routing, and `omissions` must report exactly those counts. At least one relation entry must actually be cut. |
| claim | The first `claim_issue` wins. A second agent gets `ISSUE_ALREADY_CLAIMED`. |
| update | A priority-only compact `update_issue`, then `comment_on_issue` and `link_issue`. Each one must show up in `list_activity`. Also measures a full-response update on the heavy issue. |
| recovery | Claim and update, then disconnect while a human edits the issue. After reconnecting, the agent finds its work through `assignee`. The stale `expectedRevision` is rejected and nothing is written. The update with the fresh revision succeeds. The agent then reads the run event log to the end with no gaps. |
| concurrent | Another agent mutates between pages. Identifier-order cursors must complete with every row after the key plus the inserts. `priority`/`updatedAt` moves and search relevance or membership changes must return `ISSUE_CURSOR_STALE`. A restart then equals the current set. |
| parity | `tracker issue list --json` and `tracker issue context --json` must deep-equal the MCP text payload. |

## Baselines and ceilings

The two harness columns come from running the same seed through a portable probe at each
commit. Only the probe was copied in, into a detached scratch worktree:

- `66ce9db` is LF-132, the commit before the LF-137..LF-144 batch.
- `e3bd0a4` is `origin/main` after LF-142.

The audit column is the September 2026 audit quoted in LF-145. It used different fictional data
and was **not reproduced by this harness**. Each ceiling is roughly the `e3bd0a4` value plus
20–25%. A `structuredBytes` ceiling of 0 pins a response to text only.

Single calls are shown as text / structured bytes:

| Measure | Audit | Harness @ 66ce9db | Harness @ e3bd0a4 | Ceiling |
| --- | --- | --- | --- | --- |
| `coding` catalog (tools / bytes) | 34 / 18,234 | 18 / 24,426 | 20 / 35,052 | 24 / 43,000 |
| `full` catalog (tools / bytes) | 70 / 39,138 | 74 / 56,850 | 77 / 95,760 | 92 / 118,000 (and < 128 KiB) |
| Default 50-issue page | 9,212 | 9,771 / – | 9,769 / 9,769 | 12,000 / 12,000 |
| Five search results | 1,149 | 1,451 / – | 1,451 / 1,451 | 1,800 / 1,800 |
| Verbose `get_issue` (heavy issue) | 55,195 | 68,261 / – | 68,261 / 0 | 82,000 / 0 |
| Priority-only `update_issue`, full response | 55,195 | 68,261 / – | 68,261 / 68,261 | 82,000 / 82,000 |
| Priority-only `update_issue`, compact | n/a | 142 / – | 141 / 141 | 175 / 175 |
| `get_work_context` default | n/a | unavailable | 16,440 / 0 | 19,700 / 0 |

`66ce9db` had no `structuredContent`, so its structured column is "–". The heavy issue's
verbose read carries the 40 KB body and the latest 10 comments.

Whole phases, measured at `e3bd0a4` only. The `66ce9db` commit has no `get_work_context`, no
paged `list_activity` and no structured output, so the phases cannot run there.

| Phase | toolCalls | combinedPayloadBytes | jsonRpcBytes | Ceiling (calls / combined / JSON-RPC) |
| --- | --- | --- | --- | --- |
| discovery | 4 | 135,575 | 136,444 | 5 / 163,000 / 164,000 |
| actionable | 12 | 57,872 | 61,859 | 15 / 70,000 / 75,000 |
| requirements | 49 | 222,791 | 230,326 | 62 / 268,000 / 277,000 |
| claim | 3 | 2,038 | 2,440 | 4 / 2,500 / 3,000 |
| update | 8 | 145,455 | 147,623 | 10 / 175,000 / 178,000 |
| recovery | 10 | 18,611 | 21,388 | 13 / 23,000 / 26,500 |
| concurrent | 27 | 185,026 | 196,762 | 34 / 223,000 / 237,000 |
| parity | 2 | 31,124 | 32,651 | 3 / 37,500 / 39,500 |

The tables above were measured before the requirements issue got its parent, blockers and
repository routing. That seed change, together with the extra reads in the independent omission
check, moved these values. All of them are still under the unchanged ceilings:

| Measure | Before | After | Ceiling |
| --- | --- | --- | --- |
| Verbose `get_issue` (heavy issue) | 68,261 / 0 | 69,489 / 0 | 82,000 / 0 |
| Priority-only `update_issue`, full response | 68,261 / 68,261 | 69,489 / 69,489 | 82,000 / 82,000 |
| requirements phase (calls / combined / JSON-RPC) | 51 / 223,156 / 230,879 | 52 / 225,933 / 234,188 | 62 / 268,000 / 277,000 |
| update phase | 8 / 145,455 / 147,623 | 8 / 147,911 / 150,207 | 10 / 175,000 / 178,000 |
| concurrent phase | 27 / 185,026 / 196,762 | 28 / 193,710 / 205,967 | 34 / 223,000 / 237,000 |
| parity phase | 2 / 31,124 / 32,651 | 2 / 31,124 / 32,833 | 3 / 37,500 / 39,500 |

The "Before" requirements row already includes the two relation reads added by the first review
round (49 calls at `e3bd0a4`). The concurrent phase takes one more page because there are more
live issues.

The small-fixture response ceilings in `tool-catalog-size.test.ts` are listed in
`budgets.ts` under `responses`.

## Regenerating

```sh
npm run typecheck && npm run build   # the CLI parity phase spawns packages/cli/dist
WORKLOAD_REPORT=/tmp/workload.json TOOL_SIZE_REPORT=/tmp/tool-size.json \
  npx vitest run --config vitest.workspace.ts packages/mcp/test/agent-workflow-budget.test.ts packages/mcp/test/tool-catalog-size.test.ts
```

Both reports are opt-in, and the tests never read them. The byte counts are deterministic, so a
change in the numbers means a payload changed. When a payload grows on purpose, edit
`budgets.ts` in the same change and update the provenance comment and the tables above.
