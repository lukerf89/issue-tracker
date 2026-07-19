# PRD: Autonomous Coding Runs

> Launch, monitor, and control autonomous coding workflows from Linekeeper, with
> user-configurable model roles and a durable audit trail in Issue Tracker.

**Status:** Draft

**Target:** Post-M2 product slice

**Primary surface:** Linekeeper TUI

**Peer surfaces:** `tracker` CLI and MCP

## 1. Summary

Issue Tracker should let a user select an issue in the Linekeeper TUI, launch an
autonomous coding workflow against a local repository, leave it running in the
background, and monitor or intervene from the TUI.

The product should treat a coding **run** as a first-class, durable resource. A
run records the workflow, repository, worktree, model assignments, provider
sessions, phase transitions, questions, verification evidence, artifacts, and
outcome for one concrete attempt to execute an issue.

Linekeeper is the control plane for these runs. It is not a terminal multiplexer
or a screen scraper. Provider-native output from Claude Code, Codex, and future
engines is normalized into structured run events. Raw logs remain available as
a drill-down surface.

The first workflow should be a built-in `issue-delivery` workflow:

```text
preflight -> plan -> optional opposing-model plan review
          -> isolated implementation
          -> independent verification
          -> adversarial cross-review
          -> address blocking findings
          -> draft pull request
          -> human merge gate
```

Users configure which engines and models occupy the workflow roles. The trust
guarantees of the workflow remain fixed.

## 2. Why this belongs in Issue Tracker

Issue Tracker already has the product seams needed to coordinate agent work:

- Agents and humans share the actor model.
- Issues can be assigned to an agent.
- Branches, commits, and pull requests can be attached to an issue.
- Activity is append-only and machine-readable.
- `tracker watch` provides a cursor-based activity feed.
- Linekeeper already displays agent attribution and recent agent activity.
- CLI and MCP use the same core services and schemas.

The missing concept is the execution itself. An actor such as `@codex` says who
did something, but it does not identify one particular attempt, its model
configuration, its worktree, its child sessions, or why it succeeded or failed.
A first-class run fills that gap.

## 3. Research findings that shape the product

The feature is informed by existing local multi-agent orchestration practices
and current provider capabilities.

### 3.1 Proven local orchestration patterns

The useful patterns are:

1. **A thin human-control spine around an autonomous background span.** Human
   clarification and merge decisions remain outside the unattended workflow.
2. **Structured state is authoritative.** Phase, status, pull request, and
   completion are read from structured records. Terminal text is a fallback,
   not the product contract.
3. **Worktree isolation is the default.** Concurrent work must not move a shared
   checkout or mix commits between issues.
4. **Provider self-reports require reconciliation.** A process exit code or an
   agent's claim of success is not equivalent to verified success.
5. **The requested model and the actual model are both recorded.** Fallbacks
   must be explicit and visible.
6. **A model must not be its only reviewer.** Cross-model review and a
   deterministic finding reconciliation reduce correlated blind spots.
7. **Disk state survives UI and context loss.** Closing the TUI or restarting
   the machine must not erase knowledge of what ran or what shipped.
8. **One human control surface prevents ambiguous input.** Users direct runs
   through Issue Tracker rather than typing into an unmanaged execution pane.
9. **Model defaults must be pinned or snapshotted.** Rolling provider defaults
   can change between otherwise identical runs.
10. **No output is itself a health signal.** Process liveness and workflow
    progress must be tracked separately so stalled sessions can be detected.

### 3.2 Provider feasibility

Claude Code exposes non-interactive execution, JSON and streaming JSON output,
explicit model and permission selection, and session resume. Codex exposes
non-interactive JSON execution, structured final output, resumable threads, a
TypeScript SDK, and an app-server event protocol.

These capabilities are sufficient for local provider adapters that implement a
common Issue Tracker run protocol without depending on terminal rendering.

References:

- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Codex non-interactive mode](https://developers.openai.com/codex/non-interactive-mode)
- [Codex SDK](https://developers.openai.com/codex/codex-sdk)
- [Codex App Server](https://developers.openai.com/codex/app-server)

## 4. Product principles

1. **The TUI is a control plane, not a process owner.** Runs continue when the
   TUI exits.
2. **Core owns run behavior.** Lifecycle rules, validation, concurrency guards,
   audit requirements, and transitions live in `packages/core`.
3. **Human/machine parity remains absolute.** TUI, CLI, and MCP invoke the same
   run services with the same schemas.
4. **Structured events before raw logs.** Users should understand progress
   without reading a model transcript.
5. **Evidence before claims.** Completion is based on independently observed
   verification and artifacts.
6. **Isolation before parallelism.** A run gets a worktree unless the selected
   workflow is explicitly read-only.
7. **No silent degradation.** Engine substitution, skipped review, missing
   verification, and partial completion are visible states.
8. **Human authority at irreversible boundaries.** Merge is a human gate by
   default. Destructive or externally visible actions require an explicit
   policy.
9. **Local-first and private.** Run data, logs, prompts, and model selections stay
   in local Issue Tracker storage. Provider credentials remain provider-owned.
10. **History is append-only.** Retries create attempts; they do not rewrite what
    happened previously.

## 5. Goals

- Launch a coding run from a selected issue in Linekeeper.
- Configure provider and model assignments at the user level.
- Route a run to a registered local repository and isolated worktree.
- Show meaningful live progress across workflow phases and child participants.
- Allow the user to answer questions, approve actions, redirect, stop, and
  resume from Issue Tracker.
- Continue running after the TUI closes and recover after restarts.
- Detect crashes and stalls distinctly from normal long-running work.
- Attach branches, commits, and draft pull requests to the originating issue.
- Present verification and cross-review evidence before recommending merge.
- Preserve a durable, queryable audit trail through core, CLI, and MCP.

## 6. Non-goals for the first release

- A general graphical workflow builder.
- A full terminal emulator inside Linekeeper.
- Parsing arbitrary terminal UI output as the primary status mechanism.
- Hosted or remote execution managed by Issue Tracker.
- Storing provider API keys in the Issue Tracker database.
- Automatic merging by default.
- Automatically resolving ambiguous multi-repository work.
- Unlimited parallelism or batch orchestration.
- Replacing provider-native configuration, authentication, or instruction files.
- Capturing every token or tool payload in the main activity table.

## 7. Primary user and job to be done

### Primary user

A single local operator who plans work in Issue Tracker and uses multiple coding
agents to implement and review changes across local repositories.

### Job to be done

> When an issue is ready to implement, I want to delegate it to a trusted,
> configurable autonomous workflow and stay aware of its progress from the same
> place I manage the issue, so I can intervene only when judgment is needed and
> receive a reviewable, verified result.

## 8. End-to-end experience

1. The user selects `ENG-42` in Linekeeper and presses `r`.
2. Issue Tracker resolves the issue's project to a registered repository.
3. A launch preview shows the workflow profile, target repository, base branch,
   worktree, model roles, permission policy, verification commands, and allowed
   side effects.
4. The user confirms. Issue Tracker creates the run transactionally before the
   external process starts.
5. A background supervisor provisions the worktree and launches the orchestrator.
6. Linekeeper returns to the issue list. `ENG-42` now shows the live phase,
   elapsed time, and active engine.
7. The user may quit and reopen Linekeeper without affecting the run.
8. A participant that needs a decision moves the run to `waiting_for_input` and
   supplies a structured question.
9. The user answers from Linekeeper. The supervisor delivers the response to the
   correct provider session.
10. The workflow independently verifies the implementation, runs adversarial
    review, and opens a draft pull request.
11. Issue Tracker attaches the branch, commit, and pull request; posts a concise
    run summary; and moves the issue to the configured review state.
12. The user reviews the evidence and decides whether to merge outside the
    autonomous span.

## 9. Linekeeper experience

### 9.1 Issue list

An issue with a current or recent run gains one concise status line:

```text
> ENG-42 Add export retries
  In Progress  High
  @claude-orchestrator  10:42
  run: ● Implement · 14m · Codex
```

Priority presentation rules:

1. `waiting_for_input`, `blocked`, `failed`, and `stalled`
2. active phase and elapsed time
3. completed outcome and pull request
4. ordinary issue activity

### 9.2 Issue detail

Add a `Runs` section alongside metadata, sub-issues, description, and comments.
It shows the active run first, followed by prior attempts.

```text
ACTIVE RUN
issue-delivery · FULL
Repo: example-service
Worktree: …/eng-42

Preflight   ✓
Plan        ✓  Claude
Implement  ●  Codex
Verify      ○
Review      ○  Claude + Codex
Finalize    ○
```

### 9.3 Fleet view

`R` opens a run roster containing active, waiting, stalled, failed, and recently
completed runs.

Each row shows:

- issue identifier and title
- repository
- workflow phase
- execution state
- active participant and model
- elapsed time
- time since last progress
- pull request, if present

### 9.4 Run detail

A run detail view has four logical tabs:

- **Summary:** workflow, configuration, phase, state, repository, worktree,
  branch, verification, and outcome
- **Timeline:** normalized run events in order
- **Participants:** orchestrator, implementer, verifier, reviewers, provider
  session IDs, and their current states
- **Logs and artifacts:** raw provider logs, diff, test results, commits, and pull
  request

### 9.5 Initial key bindings

| Key | Action |
| --- | --- |
| `r` | Preview and launch a run for the selected issue |
| `R` | Open the fleet view |
| `L` | Open logs for the selected run |
| `i` | Send input or answer a structured question |
| `x` | Stop or cancel the selected run |
| `u` | Resume or retry a stopped, failed, or stalled run |
| `o` | Open the worktree or pull request |

Final bindings should be checked against the complete Linekeeper key map before
implementation.

## 10. User stories and acceptance criteria

### US-1: Configure engines

> As a user, I want to define available coding engines, so Issue Tracker can
> launch the provider and model combinations I trust.

Acceptance criteria:

- An engine has a stable local name, adapter type, model, and provider-specific
  options.
- Supported initial adapters are `claude-code` and `codex`.
- Model, reasoning effort, permission mode, sandbox mode, executable path, and
  environment overrides can be configured where supported.
- Configuration validation reports an unavailable executable, malformed model
  setting, or unsupported option before a run launches.
- Credentials are not stored or echoed by Issue Tracker.
- Engine configuration is available through core, CLI, MCP, and Linekeeper.

### US-2: Configure workflow profiles

> As a user, I want named orchestration profiles, so I can choose an appropriate
> cost and assurance level without configuring every role for every issue.

Acceptance criteria:

- A profile assigns engines to orchestrator, planner, implementer, verifier, and
  reviewer roles.
- The built-in `issue-delivery` workflow supports `lite`, `full`, and `auto`
  review depth.
- A profile defines isolation, permission, fallback, push, draft-PR, and merge
  policies.
- A user may override a profile for one launch.
- The fully resolved profile is snapshotted on the run.
- A missing required role or incompatible adapter fails validation before launch.

Illustrative user configuration:

```toml
[engines.claude-primary]
adapter = "claude-code"
model = "claude-opus-4-8"
permissionMode = "autonomous"

[engines.codex-implement]
adapter = "codex"
model = "gpt-5.6-sol"
reasoningEffort = "medium"
sandbox = "workspace-write"

[profiles.issue-delivery]
workflow = "issue-delivery"
orchestrator = "claude-primary"
planner = "claude-primary"
implementer = "codex-implement"
verifier = "claude-primary"
reviewers = ["claude-primary", "codex-implement"]
reviewDepth = "auto"
isolation = "worktree"
mergePolicy = "human"
```

The exact configuration format and storage location remain an implementation
decision. Secrets must not be accepted in this configuration.

### US-3: Register repositories

> As a user, I want projects associated with validated local repositories, so a
> run knows where and how to work.

Acceptance criteria:

- A repository record contains a name, canonical local path, default branch,
  optional remote, setup command, test command, and verification command.
- A project may declare a default repository.
- An issue may override the project repository or select multiple repositories.
- Repository paths are canonicalized and must point to a valid repository.
- The launch preview identifies missing dependencies, dirty checkout state,
  missing instructions, and absent verification commands.
- Ambiguous or multi-repository routing requires explicit confirmation.

### US-4: Preview and launch a run

> As a user, I want to see exactly what an autonomous run will do before it
> starts.

Acceptance criteria:

- Pressing `r` on an issue opens a launch preview rather than immediately
  spawning a process.
- The preview shows the repository, base branch, worktree, profile, role-to-model
  mapping, permission policy, verification commands, and side-effect policy.
- The issue description and acceptance criteria form the work order.
- One active run per issue is allowed by default.
- Starting another active run requires an explicit override and a separate
  worktree.
- A run record and initial event are committed before process launch.
- Launch failure records a terminal reason without incorrectly moving the issue
  to an active workflow state.

### US-5: Run independently of Linekeeper

> As a user, I want runs to continue after I close Linekeeper, so the UI is not a
> single point of failure.

Acceptance criteria:

- A background supervisor owns provider processes and event ingestion.
- Quitting Linekeeper does not terminate active runs.
- Reopening Linekeeper reconstructs current state from SQLite and provider
  session identifiers.
- Supervisor restart reconciliation compares stored state with process and
  provider state.
- A missing process without a terminal result becomes `crashed`, not `succeeded`.
- A provider session that can be resumed remains linked to the same run attempt.

### US-6: Monitor progress

> As a user, I want meaningful live progress, so I can understand a run without
> reading a transcript.

Acceptance criteria:

- Linekeeper updates while it remains open.
- Each run shows workflow phase and execution state separately.
- Phase changes, questions, verification results, review findings, artifacts,
  fallbacks, and terminal outcomes are structured events.
- Raw messages and tool output are stored outside ordinary issue activity.
- The issue activity feed receives concise, meaningful run breadcrumbs.
- Provider-specific event types are normalized while retaining the raw source
  payload in the log when configured.

### US-7: Intervene safely

> As a user, I want to answer, approve, redirect, or stop a run from Issue
> Tracker, so there is one unambiguous control surface.

Acceptance criteria:

- A structured question identifies the participant and phase that asked it.
- The run enters `waiting_for_input` while a blocking answer is outstanding.
- The user can respond through TUI, CLI, or MCP.
- A permission request displays the proposed tool or command and affected scope.
- Supported providers can be interrupted and redirected without starting a new
  run.
- Stop offers graceful cancellation before force termination.
- A stopped run preserves logs, branch, worktree, and recovery instructions.
- Sending input to an exited process is rejected rather than executed by a shell.

### US-8: Detect stalls and recover

> As a user, I want the tracker to distinguish slow work from dead work and offer
> safe recovery choices.

Acceptance criteria:

- Runs record process liveness, `lastEventAt`, and `lastProgressAt` separately.
- A configurable interval without progress produces a `stalled` warning.
- A stall does not automatically kill the process in the first release.
- Recovery choices include wait, nudge, resume provider session, retry phase, or
  restart with another engine.
- Retries create a new attempt under the same run.
- Fallback records requested engine, actual engine, reason, and artifact handling.
- Resume never relies on ambiguous "last session" semantics.

### US-9: Verify and review the result

> As a user, I want evidence that the implementation works and received
> independent review before I consider merging it.

Acceptance criteria:

- Completion shows files changed, diff size, tests run, failures, risk notes,
  branch, commit, and pull request.
- Provider self-report and independently observed verification are separate.
- A clean provider exit without the required structured result is a failure.
- Behavioral verification must run in the worktree against the produced change.
- The implementer cannot be its only reviewer.
- Review findings are preserved as `agreed`, `binding_only`, and
  `adversary_only`; they are not silently merged.
- Missing required review is not interpreted as approval.
- The workflow may open a draft pull request but cannot merge under the default
  policy.

### US-10: Preserve and inspect history

> As a user, I want to understand exactly how an issue was executed later.

Acceptance criteria:

- An issue retains all runs and attempts in deterministic order.
- Each run records its resolved model profile, permissions, provider sessions,
  worktree, branch, phases, interventions, verification, and outcome.
- Run events are append-only.
- Large logs and transcripts are local artifacts referenced by path and checksum.
- Export and backup include structured run history; raw-log inclusion is an
  explicit option.
- Cleanup archives the run record and may independently remove a worktree or raw
  logs after confirmation.

### US-11: Operate a small fleet

> As a user, I want to see and control several independent runs, so I can safely
> delegate work across repositories.

Acceptance criteria:

- The supervisor enforces configurable global and per-repository concurrency.
- Same-repository concurrent runs always use distinct worktrees.
- The fleet view survives TUI and supervisor restarts.
- Waiting, blocked, stalled, and failed runs sort ahead of healthy running runs.
- Bulk stop is out of scope for the first release.

## 11. Run lifecycle

Workflow **phase** and execution **state** are independent dimensions.

### 11.1 Initial phases

- `preflight`
- `plan`
- `implement`
- `verify`
- `review`
- `finalize`
- `complete`

### 11.2 Execution states

- `queued`
- `provisioning`
- `running`
- `waiting_for_input`
- `blocked`
- `stalled`
- `succeeded`
- `partial`
- `failed`
- `canceled`
- `crashed`

### 11.3 Required transition rules

- Terminal states cannot return to `running`; recovery creates a new attempt.
- Only one attempt within a run may be active.
- `succeeded` requires the workflow's structured result and all required
  verification gates.
- Process exit without a terminal workflow result becomes `crashed` or `failed`.
- `waiting_for_input` requires at least one unresolved input request.
- `stalled` is a health classification and retains the current workflow phase.
- A phase transition and its run event are committed in one transaction.
- Issue state changes caused by a run occur in the same transaction as the
  corresponding activity entry.
- Fallback never rewrites the original participant or attempt.

## 12. Conceptual data model

Names are provisional; the relationships are the product requirement.

### Repository

| Field | Notes |
| --- | --- |
| `id` | UUID |
| `name` | unique display/lookup name |
| `path` | canonical local path |
| `defaultBranch` | normally `main` |
| `remote` | optional remote name |
| `setupCommand` | optional dependency preflight |
| `testCommand` | required for implementation eligibility |
| `verifyCommand` | optional additional lint/build/typecheck command |
| `archivedAt` | archival rather than deletion |

Projects require a repository association table so an issue can inherit one or
more repositories while retaining an issue-level override.

### OrchestrationProfile

| Field | Notes |
| --- | --- |
| `id` | UUID |
| `name` | unique profile name |
| `workflow` | built-in workflow identifier |
| `configuration` | validated JSON snapshot of role and policy settings |
| `isDefault` | optional default profile |
| `archivedAt` | archival rather than deletion |

Engine definitions may be stored in machine-local configuration rather than the
portable workspace snapshot. A run always stores the resolved non-secret engine
snapshot it actually used.

### AgentRun

| Field | Notes |
| --- | --- |
| `id` | UUID |
| `issueId` | originating issue |
| `profileId` | optional source profile |
| `workflow` | stable workflow identifier |
| `resolvedConfig` | non-secret immutable launch snapshot |
| `phase` | current workflow phase |
| `state` | current execution state |
| `repositoryId` | primary repository |
| `baseRef` | immutable or named base used at launch |
| `branchName` | run branch, nullable before provisioning |
| `worktreePath` | local path, nullable before provisioning |
| `startedAt` | nullable until supervisor starts it |
| `lastEventAt` | latest observed provider event |
| `lastProgressAt` | latest meaningful progress |
| `completedAt` | nullable terminal timestamp |
| `outcomeSummary` | nullable concise terminal summary |
| `errorCode` / `errorMessage` | nullable structured failure |

### RunAttempt

| Field | Notes |
| --- | --- |
| `id` | UUID |
| `runId` | parent run |
| `number` | monotonic within the run |
| `reason` | initial, retry, fallback, or resume |
| `requestedEngine` | user/profile request |
| `actualEngine` | resolved engine |
| `state` | attempt lifecycle |
| `startedAt` / `completedAt` | timestamps |
| `result` | normalized structured result |

### RunParticipant

| Field | Notes |
| --- | --- |
| `id` | UUID |
| `attemptId` | owning attempt |
| `actorId` | Issue Tracker actor |
| `role` | orchestrator, planner, implementer, verifier, reviewer |
| `adapter` | provider adapter identifier |
| `model` | resolved model identifier |
| `providerSessionId` | explicit resumable session/thread ID |
| `state` | queued, running, waiting, completed, failed |

### RunEvent

| Field | Notes |
| --- | --- |
| `id` | UUID |
| `runId` / `attemptId` | owning execution |
| `participantId` | nullable for supervisor events |
| `sequence` | monotonic ordering within the run |
| `type` | normalized event type |
| `data` | validated JSON payload |
| `providerEventId` | optional idempotency key |
| `createdAt` | injectable-clock timestamp |

Initial event types include:

- `run.created`, `run.started`, `run.completed`
- `phase.started`, `phase.completed`
- `participant.started`, `participant.completed`, `participant.failed`
- `input.requested`, `input.responded`
- `permission.requested`, `permission.resolved`
- `progress.updated`
- `verification.started`, `verification.completed`
- `review.finding`, `review.completed`
- `fallback.started`
- `artifact.created`
- `warning.stalled`
- `process.exited`

### RunArtifact

| Field | Notes |
| --- | --- |
| `id` | UUID |
| `runId` / `attemptId` | owning execution |
| `kind` | log, prompt, result, diff, test-report, branch, commit, pr |
| `title` | human-readable label |
| `path` / `url` | local or external reference |
| `sha256` | optional integrity check for local files |
| `metadata` | validated JSON |
| `createdAt` | timestamp |

Existing issue attachments remain the canonical issue-level branch/commit/PR
links. Run artifacts provide execution-level provenance and create or reference
those attachments when appropriate.

## 13. Service and surface contracts

All lifecycle behavior belongs in core services. Provider process I/O may live
in a runtime package, but it must request state changes through core rather than
mutating SQLite directly.

### Core service capabilities

- create, validate, start, and inspect runs
- transition phase and state with concurrency guards
- append normalized events idempotently
- create and resolve input or permission requests
- record attempts, participants, artifacts, and provider sessions
- mark stalls, failures, cancellations, and completion
- enforce one-active-attempt and one-active-run-per-issue defaults
- link verified branch/commit/PR artifacts to issues
- apply configured issue-state transitions transactionally

### CLI sketch

```text
tracker repo add|list|view|archive
tracker profile add|list|view|archive
tracker run start ENG-42 --profile issue-delivery
tracker run list [--state running|waiting_for_input|stalled|...]
tracker run view <run-id>
tracker run events <run-id> [--follow]
tracker run respond <run-id> <request-id> <text>
tracker run approve <run-id> <request-id>
tracker run stop <run-id>
tracker run resume <run-id>
tracker run retry <run-id> [--engine <name>]
```

Machine output follows the existing JSON contract. `run events --follow` emits
JSONL with a cursor.

### MCP sketch

MCP exposes equivalent tools using the same schemas:

- `list_repositories`, `get_repository`
- `list_orchestration_profiles`, `get_orchestration_profile`
- `start_run`, `list_runs`, `get_run`, `list_run_events`
- `respond_to_run`, `resolve_run_permission`
- `stop_run`, `resume_run`, `retry_run`

Starting, stopping, or approving a run is a mutation attributed to the calling
actor.

## 14. Background supervisor

The TUI cannot safely own long-running processes. A local supervisor is required.

Responsibilities:

- claim queued runs without double-launching them
- provision and validate worktrees
- launch provider adapters
- ingest and normalize provider events
- maintain provider session identifiers
- write raw logs and structured result artifacts
- deliver user responses and permission decisions
- reconcile process exit with workflow result
- detect missing progress and emit stall warnings
- resume or reconcile runs after supervisor restart
- enforce global and per-repository concurrency

The initial implementation may expose the supervisor through a command such as
`tracker agentd`. Packaging it as a user service can follow. TUI startup should
detect whether a supervisor is available and explain how to start it; it should
not silently downgrade to TUI-owned processes.

The supervisor is an infrastructure adapter. It does not own business rules.

## 15. Provider adapter contract

Each adapter must support a declared capability set rather than pretending all
providers behave identically.

Required baseline capabilities:

- validate local installation and authentication
- start a participant with explicit model and working directory
- stream or poll structured events
- capture a stable provider session/thread ID
- obtain a terminal structured result
- stop the participant
- report process liveness

Optional capabilities:

- resume
- interrupt and redirect
- interactive permission confirmation
- structured output schema enforcement
- child-participant discovery
- token or cost reporting

If a workflow requires a capability the selected adapter lacks, validation fails
before launch or the launch preview clearly identifies the reduced behavior.

## 16. Built-in `issue-delivery` workflow

### Preflight

- Resolve repository and base ref.
- Refuse an invalid path or missing verification contract.
- Create a unique worktree and branch.
- Run the registered setup command.
- Record exact commands and outcomes.

### Plan

- Produce a concrete file, test, risk, and estimated-size plan.
- For medium/high risk, have a model other than the intended implementer review
  the approach before code is written.
- Fold accepted recommendations into the final plan and preserve rejected
  recommendations with reasons.

### Implement

- Run the selected implementer in the worktree.
- Require behavioral tests for changed behavior.
- Capture the provider's structured self-report.
- Never infer success from process exit alone.

### Verify

- Run the repository's registered test and verification commands independently
  of the implementer's claim.
- Classify the result as clean, honest partial, fixable partial, audit drift,
  blocked, or engine failure.
- Use the profile's explicit fallback policy when allowed.

### Review

- Run at least one binding reviewer and one independent adversarial perspective.
- Assert that the implementer is not the sole reviewer.
- Preserve agreed and divergent findings separately.
- Treat absence of a required review as a blocking failure.

### Finalize

- Address binding blocking findings in the same isolated branch.
- Re-run required verification after changes.
- Push according to policy.
- Open a draft pull request according to policy.
- Attach branch, commit, and pull request to the issue.
- Return control for the human merge gate.

## 17. Safety, permissions, and privacy

- Permission policy is explicit in every profile and launch preview.
- Autonomous mode is allowed for the single local operator but must be visually
  conspicuous.
- Merge remains human-only by default.
- Commands that delete worktrees or logs identify exact resolved paths and
  require confirmation.
- Cleanup never deletes an unmerged worktree by default.
- Provider credentials are inherited from provider-native authentication and
  never copied into Issue Tracker configuration, events, or logs.
- Environment overrides are allowlisted; secret values are redacted from UI and
  structured events.
- Raw logs are stored under the Issue Tracker data directory, outside public
  repositories.
- Public examples and tests use only fictional repositories and issues.
- Export excludes raw logs by default because prompts and tool results may
  contain private source or environment information.

## 18. Failure handling

| Failure | Required behavior |
| --- | --- |
| Provider executable missing | Fail preflight before run start |
| Provider authentication invalid | Block with provider-specific remediation |
| Worktree path collision | Stop; never reuse or overwrite implicitly |
| Setup command fails | Mark attempt failed; preserve logs and worktree |
| Provider exits without result | Mark crashed/failed, not succeeded |
| Structured result contradicts verification | Record audit drift and apply explicit fallback policy |
| Required reviewer unavailable | Block approval; absence is not a clean review |
| No progress beyond threshold | Mark stalled and offer recovery actions |
| Supervisor restarts | Reconcile process/provider state before launching anything new |
| TUI exits | No effect on active runs |
| Response targets exited participant | Reject safely; never type into a shell |
| Pull request creation fails | Preserve verified branch and return an actionable partial result |
| Cleanup fails | Preserve run record and report remaining paths |

## 19. Notifications and activity

Issue activity should include only high-value breadcrumbs:

- run launched
- phase changed
- run waiting for input
- engine fallback occurred
- verification completed or failed
- review found blocking issues
- branch/commit/pull request attached
- run completed, partially completed, failed, canceled, crashed, or stalled

High-volume provider messages, tool calls, and command output belong in the run
event/log surfaces. This prevents issue history from becoming an unreadable model
transcript.

## 20. Success measures

The first release is successful when:

- A user can launch the built-in workflow from Linekeeper without opening a
  separate terminal.
- The TUI may be closed and reopened while the run continues.
- Every active run can be reconstructed after supervisor restart.
- The TUI shows the correct phase and state without scraping terminal rendering.
- A blocked run can be answered and resumed from TUI, CLI, and MCP.
- Every terminal run has an explicit structured outcome or explicit crash reason.
- Every successful implementation has independent verification evidence.
- Every merge recommendation satisfies the configured independent-review floor.
- Branches, commits, and draft pull requests are attached to the originating
  issue with run provenance.
- No provider credential or private run log is written into the public repository.

Useful operational metrics, stored locally:

- launch success rate
- clean completion, partial, fallback, crash, and cancellation rates
- time in each phase
- time waiting for input
- stall detections and recoveries
- provider fallback rate
- verification disagreement rate
- blocking findings by source
- runs resumed successfully after restart

## 21. Delivery slices

### Slice A: Durable single-engine run

- Repository registry and project association
- Run, attempt, participant, event, artifact, and input-request schemas
- Background supervisor
- Claude Code adapter
- Worktree provisioning
- Launch preview, issue status, run detail, logs, stop
- TUI restart recovery
- CLI/MCP parity

Done when a fictional `ENG-42` run can be launched, monitored, stopped, and
reconstructed after closing Linekeeper.

### Slice B: Built-in verified delivery workflow

- Plan, implement, verify, review, finalize phases
- Registered setup/test/verification commands
- Structured results and audit-drift handling
- Draft pull request and issue attachments
- Waiting-for-input and response flow
- Stall detection and retry attempts

Done when a run produces a verified draft pull request or an accurate terminal
failure with preserved recovery artifacts.

### Slice C: User-configurable multi-model roles

- Codex adapter
- Engine and profile configuration
- Role-to-engine launch snapshot
- Explicit fallback
- Opposing-model plan review
- Cross-model adversarial review and finding divergence

Done when the user can select a profile with one provider orchestrating and
another implementing, and the final evidence identifies the actual model used by
every participant.

### Slice D: Small fleet operations

- Fleet view
- Global/per-repository concurrency controls
- Multiple independent repositories
- Resume and redirect where adapters support them
- Retention and cleanup controls

Batch planning and automatic dependency scheduling remain later work.

## 22. Risks and mitigations

### Provider churn

CLI flags, model names, stream events, and resume semantics will change.

**Mitigation:** isolate provider behavior behind versioned adapters, validate
capabilities at launch, snapshot resolved configuration, and test against
recorded provider event fixtures.

### TUI coupled to execution details

Direct child-process or terminal integration would make the TUI fragile and
prevent durable background runs.

**Mitigation:** keep process ownership in the supervisor and expose only core run
resources to Linekeeper.

### False success

An agent may claim success while tests fail, or exit cleanly without producing
the expected result.

**Mitigation:** independent verification, schema-required terminal results, and
explicit audit-drift classification.

### Shared-checkout corruption

Concurrent agents can move branches, combine changes, or invalidate each other's
context.

**Mitigation:** unique worktrees and per-repository concurrency enforcement.

### Excessive event volume

Persisting every provider delta in SQLite would increase noise and database size.

**Mitigation:** normalize meaningful events into SQLite and store raw streams as
local artifacts with retention controls.

### Unsafe autonomy

An autonomous provider can execute commands with wider effects than the user
expected.

**Mitigation:** explicit profiles, launch previews, capability validation,
visible permission policy, scoped worktrees, and human merge gates.

### Stale or ambiguous input delivery

Typing into an execution pane after its agent exits could execute text in a shell.

**Mitigation:** deliver input through provider APIs or a supervised process
channel tied to a live participant; reject delivery when participant identity or
liveness cannot be proven.

## 23. Open product decisions

1. **Configuration storage:** Should non-secret engine/profile configuration live
   in SQLite, an XDG config file, or be split between portable profiles and
   machine-local engine definitions?
2. **Supervisor startup:** Should `tracker agentd` be user-started initially, or
   should Linekeeper offer to install/start a user service?
3. **Default permission posture:** Should the first built-in profile default to
   safe approvals or autonomous worktree-scoped execution?
4. **Issue state automation:** Which transitions should be defaults for launch,
   waiting, PR ready, failure, and cancellation?
5. **Repository association:** Should the primary mapping be project-to-repo,
   team-to-repo, or a reusable workspace grouping?
6. **Raw-log retention:** What should the default retention period and size limit
   be?
7. **Cost display:** Which providers expose sufficiently reliable token or cost
   data to show it as product state rather than best-effort metadata?
8. **Resume semantics:** Should provider resume continue the same attempt, while
   retry always creates a new attempt?

Recommended initial decisions:

- Machine-local engine definitions in XDG config; portable non-secret workflow
  profiles in SQLite.
- Explicit `tracker agentd` during the first release, with a clear TUI health
  indicator.
- Project-to-repository default plus issue-level override.
- Human merge gate and no implicit deletion of worktrees.
- Resume keeps the attempt only when the provider preserves the same session and
  worktree; retry creates a new attempt.
- Raw logs excluded from export and retained until explicit cleanup in the first
  release.

## 24. Recommended first decision

Do not begin by porting every orchestration workflow or building arbitrary
workflow configuration. First establish the durable run protocol and background
supervisor with one provider and one built-in workflow. Once that control plane
is trustworthy, add configurable model roles and the second provider behind the
same contracts.

That ordering validates the hardest product property first: a run remains
observable, controllable, and recoverable independently of any particular TUI,
provider process, or model.
