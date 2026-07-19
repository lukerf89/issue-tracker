# PR #16 Provider E2E Remediation Plan

> Implementation plan for the findings from live Anthropic and OpenAI testing of
> PR #16 (`Implement autonomous coding runs`). This plan supplements the autonomous
> coding runs PRD and implementation plan; it does not expand the product scope.

**Status:** Ready for implementation

**Priority:** Release blocking

**Scope:** Provider schema compatibility, provider health preflight, durable failure
reconciliation, model attribution, and provider-backed acceptance coverage

---

## 1. Outcome

PR #16 is ready when an authenticated Claude Code engine and an authenticated Codex
engine can each complete the existing `issue-delivery` workflow from preview through
finalization, while invalid authentication and invalid provider contracts fail before
a run is created.

The remediation must preserve these boundaries:

1. `packages/core` remains authoritative for canonical participant results, run
   validation, durable state transitions, and terminal outcomes.
2. Provider adapters own provider-specific command lines, transport schemas, event
   parsing, and normalized provider diagnostics.
3. CLI and MCP remain thin adapters over the same core services.
4. Raw provider output remains private; structured diagnostics must be safe to show.
5. CI remains credential-free. Live provider tests are explicit, opt-in acceptance
   tests, not ordinary CI jobs.

## 2. Findings addressed

| ID | Severity | Finding | Required outcome |
| --- | --- | --- | --- |
| F1 | P0 | The shared JSON Schema is rejected by Claude Code and OpenAI | Each adapter emits a schema accepted by its provider while validating the final value against the canonical core schema |
| F2 | P0 | Preflight reports an expired provider session as healthy | Unauthenticated or inaccessible configured models block launch with remediation |
| F3 | P1 | Participant exit terminalizes the run before its claimed action completes | Participant exit, action completion/failure, and workflow reduction reconcile atomically |
| F4 | P1 | Failed requests record the requested model as the actual model | `actualModel` is null until provider evidence identifies it |
| F5 | P1 | Existing tests do not exercise real provider schema constraints | Behavioral contract tests cover both provider schema dialects and failure paths |

## 3. Fixed design decisions

### 3.1 Canonical result versus transport schemas

Keep `participantResultSchema` in core as the canonical stored and behavioral
contract. Do not weaken it to accommodate a provider transport.

Create provider-specific transport-schema generation under
`packages/agentd/src/adapters/`:

- `claude-code` receives a Claude-compatible JSON Schema without an unsupported
  Draft 2020-12 declaration. Preserve the canonical optional-field semantics.
- `codex` receives a strict OpenAI-compatible schema in which every declared
  property is required and every object has `additionalProperties: false`.
- Generate role-aware schemas. Planner output declares and requires `risk` and
  `estimatedSize`; non-planner output does not declare those properties.
- `findings[].file` and `findings[].location` are required-but-nullable in the Codex
  transport schema. They remain optional/nullable in the canonical core schema.
- Every provider result is parsed from transport output and then validated again
  with `participantResultSchema`. Transport acceptance never bypasses core.

Avoid maintaining two handwritten copies of the whole participant contract. Build a
small transformation layer with tests that compare the transport schemas to the
canonical contract's behavior.

### 3.2 Provider health is durable preflight evidence

Executable discovery is not authentication validation. Add a durable engine-health
snapshot managed through core:

- Key health by engine name plus a stable fingerprint of adapter, executable, model,
  relevant options, and allowlisted environment-variable names.
- Store `installed`, `authenticated`, `modelAccessible`, `checkedAt`, a normalized
  diagnostic code, and safe remediation text.
- The supervisor probes engines on startup, when the catalog fingerprint changes,
  and after a bounded health TTL expires.
- Preview reads fresh health evidence through core. Missing, stale, unauthenticated,
  or model-inaccessible evidence is a preflight error.
- Start rechecks the health fingerprint when it revalidates the preview fingerprint.

Provider probes must use the same executable, model, allowlisted environment, and
environment stripping as real execution. A version command alone is never an auth
probe. Prefer the lightest provider-native request that proves credentials can be
refreshed and the configured model can accept a structured no-op request. Cache the
result so preview does not repeatedly spend tokens.

### 3.3 Participant completion is one durable operation

Replace the current sequence—record process exit, terminalize the run, then complete
the claimed action—with a single core operation for participant actions.

The operation must, in one transaction:

1. verify the action lease and active attempt;
2. validate the participant, provider exit status, session, and structured result;
3. update participant and action terminal states;
4. store a normalized action result or error;
5. update the run/attempt outcome when execution failed;
6. append participant, action, and run events in deterministic order; and
7. reduce a successful participant result into the next workflow action.

Provider events and private logs may be ingested before this operation because they
are independently idempotent. The participant completion operation is the authority
for terminal state. The supervisor must not call generic `failRunAction` after the
participant action has already become terminal.

Normalized failure codes should include at least:

- `provider_authentication_failed`
- `provider_model_unavailable`
- `provider_schema_rejected`
- `provider_exit_nonzero`
- `provider_result_missing`
- `provider_result_invalid`
- `provider_process_crashed`

Store only safe summaries in action/run errors. Keep complete stdout/stderr in the
private raw-log artifact.

### 3.4 Requested and actual model remain separate facts

- Preview and run creation record `requestedModel` only.
- Preview `actualModel` is always `null`.
- Adapters return `actualModel: null` unless a provider event or terminal response
  explicitly identifies the model actually used.
- A schema rejection, authentication failure, or other failure before inference must
  leave `actualModel` null.
- Fallbacks create or update the appropriate attempt/participant evidence; they do
  not overwrite requested-model history.

## 4. Implementation sequence

### Phase 0 — Lock in reproductions

Add failing behavioral tests before changing production behavior.

Target areas:

- `packages/agentd/test/adapters/`
- `packages/agentd/test/supervisor.test.ts`
- `packages/core/test/autonomous-runs.test.ts`

Tests:

1. Claude schema rejects an unsupported `$schema` declaration in the fixture client.
2. Codex fixture enforces OpenAI strict-schema requirements recursively.
3. A nonzero participant result retains its provider failure rather than replacing it
   with an illegal post-terminal action-completion error.
4. A request rejected before inference leaves `actualModel` null.
5. Stale or unhealthy engine evidence blocks preview and start.

**Done when:** each test fails for the observed E2E reason on the current PR branch.

### Phase 1 — Provider-compatible structured output

1. Add a role-aware provider output-schema builder.
2. Update `ClaudeCodeAdapter` and `CodexAdapter` to request the schema for the active
   participant role.
3. Continue canonical validation through `isParticipantResult` after provider output
   is decoded.
4. Normalize schema-rejection diagnostics without copying raw prompts or output into
   public events.
5. Add fixture streams for accepted planner, implementer, and reviewer results from
   both providers.

**Done when:**

- the generated Claude schema passes the Claude fixture validator;
- the generated Codex schema passes recursive strict-schema validation;
- planner and non-planner results round-trip through transport and canonical schemas;
- missing required planner fields still fail canonical validation; and
- the original live schema errors are covered by tests.

### Phase 2 — Atomic participant/action reconciliation

1. Introduce the core participant-action completion input schema and service.
2. Move terminal participant, action, attempt, run, and reducer changes into its
   transaction.
3. Update the supervisor to ingest events/logs, then call this service exactly once.
4. Make retries and duplicate reports idempotent by action ID and lease owner.
5. Preserve the first authoritative provider failure when later reconciliation is a
   no-op or duplicate.

**Done when:**

- a successful participant action queues the next workflow action once;
- provider failure produces one terminal run event and one actionable error;
- action error and run error agree on the normalized failure code;
- replaying completion does not duplicate events or next actions; and
- supervisor restart tests still pass.

### Phase 3 — Accurate engine health and model attribution

1. Add the engine-health schema, migration, core service, and public barrel exports.
2. Add supervisor probing and bounded refresh.
3. Include engine-health fingerprints in preview/start revalidation.
4. Surface remediation through CLI and MCP using the standard error envelope.
5. Change preview and adapters so actual-model evidence begins as null and is updated
   only from explicit provider facts.

If a new CLI readout is useful, prefer `tracker engine health` over changing the
meaning of static `tracker engine validate`. Keep CLI/MCP parity for any new surface.

**Done when:**

- missing executable, expired authentication, inaccessible model, stale health, and
  healthy engine are behaviorally distinct;
- expired Anthropic OAuth is rejected before `startRun`;
- a healthy Codex model passes preflight;
- changed engine configuration invalidates old health evidence; and
- failures before inference retain `actualModel: null`.

### Phase 4 — Automated regression and live acceptance harness

Add an opt-in script or Vitest project that:

1. creates a fictional temporary Git repository and tracker database;
2. registers test and verification commands;
3. creates provider-specific profiles;
4. previews and starts a run;
5. runs `tracker-agentd` to a bounded terminal outcome;
6. asserts worktree isolation, commit creation, independent verification, review
   evidence, final state, event ordering, and private-log permissions; and
7. performs explicit cleanup without publishing.

Gate live execution behind explicit environment flags such as
`ISSUE_TRACKER_E2E_CLAUDE=1` and `ISSUE_TRACKER_E2E_CODEX=1`. Never run it in ordinary
CI or print credentials/raw logs.

**Done when:** authenticated local runs for both providers reach `succeeded` on the
same fictional task, and the harness produces a redacted summary suitable for a PR
verification note.

## 5. Required test matrix

| Layer | Claude | Codex | Credential requirement |
| --- | --- | --- | --- |
| Canonical result validation | Yes | Yes | None |
| Provider transport-schema validation | Yes | Yes | None |
| Captured JSONL parsing | Yes | Yes | None |
| Auth/model health state machine | Fixture | Fixture | None |
| Provider exit/action reconciliation | Fixture | Fixture | None |
| Full supervisor workflow | Fake adapter | Fake adapter | None |
| Live structured no-op | Opt-in | Opt-in | Local provider auth |
| Live issue-delivery E2E | Opt-in | Opt-in | Local provider auth |

Every behavioral test must fail if its production fix is reverted. Do not use source
grep assertions.

## 6. Verification commands

Run after each phase and before handoff:

```text
npm run typecheck
npm run lint
npm test
npm run build
```

Then run the opt-in live acceptance harness separately for Claude and Codex. Record:

- provider client version;
- requested and actual model values;
- run ID and terminal outcome;
- participant roles and independent session IDs;
- verification classifications and finalized commit;
- redacted failure code, if any; and
- confirmation that no push or pull request occurred.

## 7. Final acceptance gates

The remediation is complete only when all of the following are true:

1. Claude Code and Codex accept their generated transport schemas.
2. An unauthenticated provider cannot pass preview/start preflight.
3. An authenticated provider does not need secrets copied into Issue Tracker.
4. Separate Claude-only and Codex-only runs complete the fictional E2E task.
5. A mixed-provider profile completes with independent implementer and reviewer
   sessions.
6. Provider failures preserve an actionable normalized cause in action and run state.
7. Failed-before-inference requests never claim an actual model.
8. Verification and review gates remain unchanged and evidence-gated.
9. Raw logs remain outside exports and have mode `0600`.
10. Typecheck, lint, tests, and build pass without new warnings.

## 8. Delivery and review order

Prefer three reviewable commits or dependent PRs:

1. `LF-16: add provider-compatible result schemas`
2. `LF-16: reconcile participant actions atomically`
3. `LF-16: enforce provider health preflight`

The first two are independently testable and remove the immediate execution and
diagnostic blockers. The health change may include a migration and deserves separate
data-integrity review. Run the live provider acceptance suite only after all three are
integrated.

## 9. Risks and reviewer focus

- **Schema drift:** transport transforms can silently diverge from the canonical
  result. Review semantic tests for every role and nested finding field.
- **Probe cost and latency:** use bounded, cached probes and make freshness visible.
- **False-positive auth checks:** status/version commands are insufficient; test a
  request that exercises credential refresh and configured-model access.
- **Transaction regression:** review participant/action completion for duplicate
  events, stale leases, retry behavior, and crash boundaries.
- **Diagnostic privacy:** normalized errors must be actionable without including
  prompts, source, tokens, credentials, or raw provider payloads.
- **Model attribution:** absence of provider evidence must remain `null`, even when
  the requested model is known.
