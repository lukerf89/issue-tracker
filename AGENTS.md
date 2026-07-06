# AGENTS.md — issue-tracker

Working guide for AI agents (Codex, Claude) contributing to this repo. The full
product spec is [`docs/SPEC.md`](docs/SPEC.md); the phase-by-phase build plan and the
"Done when" acceptance gates live in `docs/IMPLEMENTATION_PLAN.md` (local, gitignored —
read it from disk for detail).

## What this is

A local-only, **agent-native** issue tracker (Linear-shaped) over local SQLite, exposed
through a CLI (`tracker`) and an MCP server. Two consumers with equal weight: a human at
the terminal, and AI agents driving work through a structured protocol.

## Golden rules (do not violate)

1. **Core owns all logic.** Every behavioral rule lives in `packages/core`. `packages/cli`
   and `packages/mcp` are thin adapters — parse input → call a core service → format
   output. They import ONLY the core package's public barrel (`@issue-tracker/core`),
   never `core/src/db`, Drizzle, or raw tables. If you're tempted to branch on a business
   rule inside cli/mcp, it belongs in core.
2. **Human/machine parity.** CLI and MCP call the same core services and validate with the
   same Zod schemas. Anything the CLI can do, MCP can, identically.
3. **Tests are the contract.** Every change ships behavioral tests that FAIL if the change
   is reverted (never source-grep assertions). An issue is done only when its "Done when"
   gates pass.
4. **JSON contract.** Machine output uses ISO-8601 timestamps, explicit `null` for absent
   optionals, camelCase keys, and deterministic ordering. Errors:
   `{ "error": { "code", "message", "details"? } }`.
5. **Transactions.** A mutation and its activity-log append happen in ONE transaction.
   Issue numbering (increment the team counter + insert) is transactional — identifiers
   never collide or reuse.
6. **Archival over deletion.** Product commands archive records; they don't hard-delete.
   Hard deletes are for tests/cleanup only.
7. **Injectable clock.** Core services take a `clock`; never call `Date.now()` directly in
   a service — deterministic timestamp tests depend on this.
8. **Public repo, private data.** Only fictional examples in code/tests/seeds
   (`ENG-1 "Set up CI"`). Never real project data. The `*.db` file is gitignored.

## Stack

TypeScript (ESM, `moduleResolution: NodeNext`, strict) · Node 22+ · npm workspaces ·
better-sqlite3 (synchronous) + Drizzle ORM/Kit · Zod · Commander + picocolors (CLI) ·
`@modelcontextprotocol/sdk` (MCP, stdio) · Vitest · tsx (dev). Target directory layout:
`docs/IMPLEMENTATION_PLAN.md` §2.

Commands (once scaffolded): `npm run typecheck` · `npm test` · `npm run build` ·
`npm run lint`.

## How to work an issue

1. Read the work order handed to you (a plan file) AND the SPEC section it references.
2. Implement ONLY that issue's scope. Do not touch `docs/`, and do not build other issues'
   work ahead of time.
3. Satisfy every "Done when" gate. Run typecheck + tests (+ build if present); iterate
   until green. If a failure is genuinely out of scope or you're blocked, stop and report
   it — do not paper over it.
4. Use fictional data only.
5. Do not commit or push unless the work order explicitly says to — the orchestrator
   commits after independently verifying.
6. **Self-report (final step):** write a JSON object to the result path given in the work
   order:
   ```json
   {
     "status": "success | partial | blocked",
     "summary": "one paragraph: what you did",
     "files_changed": ["path", "..."],
     "tests_run": ["command", "..."],
     "tests_failed": ["name or command", "..."],
     "verified_tests_passed": true,
     "risk_notes": ["anything a reviewer should double-check", "..."]
   }
   ```
   Base `status` and `verified_tests_passed` on ACTUAL command results, not intentions.
   `partial` = only out-of-scope/pre-existing failures remain; `blocked` = you couldn't
   proceed (say why in `summary`).

## Conventions

- ESM only; no CommonJS `require` in source. better-sqlite3 is CJS — rely on
  `esModuleInterop` for its default import.
- Commit messages (when asked to commit): `LF-<n>: <summary>`.
