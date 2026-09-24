# Agent guide

How an AI agent should drive `tracker` through the CLI or the MCP server without reading
more than it needs. Every recipe below is executed by
`packages/mcp/test/agent-guide.test.ts`, once through the CLI and once through MCP, so
the commands and tool calls shown here are the tested contract. The examples use the
fictional workspace `ENG-1 "Set up CI"`.

Each step is a fenced block whose info string names its recipe and track
(`recipe=<id> track=cli|mcp`). A block can also carry `capture=<name>:<field>` (store a
typed field of the result, such as `revision` or `issues.0.updatedAt`, for later
`<name>` placeholders), `expect-error=<CODE>` (the step must fail with that code) and
`repeat=cursor` (keep running the step while `<cursor>` is non-null). CLI lines assume
the database comes from `--db` or `ISSUE_TRACKER_DB`.

## Output contract

- JSON mode: pass `--json` on the CLI; MCP tools always return JSON.
- Errors are `{ "error": { "code", "message", "details"? } }`; the CLI writes the
  envelope to stderr and exits non-zero.
- Absent optional values are explicit `null`. Timestamps are ISO-8601. Keys are
  camelCase.
- `fields` (CLI `--fields a,b`) projects extra list/search columns: `stateName`,
  `stateType`, `assigneeHandle`, `revision`, and more.
- Pages default to 50 rows, allow 1–250 through `limit`, and continue with the opaque
  `nextCursor`. Reuse the same filters and sort with a cursor.

## 1. Scoped discovery

Ask for the sections you need, compactly, instead of the full metadata dump.

```sh recipe=discovery track=cli
tracker describe --team ENG --sections teams,priorities --compact --json
```

```json recipe=discovery track=mcp
{ "tool": "describe", "arguments": { "team": "ENG", "sections": ["teams", "priorities"], "compact": true } }
```

## 2. Narrow search

Search tokens are ANDed prefix matches (`ci set` matches "Set up CI"); FTS operators are
treated as literal text. Results are ranked by relevance unless you pass `sort`. Bound
the page and project only the columns you will use.

```sh recipe=narrow-search track=cli capture=since:issues.0.updatedAt
tracker issue search ci --state-types unstarted --unassigned --limit 5 --fields stateName,revision --json
```

```json recipe=narrow-search track=mcp capture=since:issues.0.updatedAt
{ "tool": "search", "arguments": { "query": "ci", "stateTypes": ["unstarted"], "assignee": null, "limit": 5, "fields": ["stateName", "revision"] } }
```

## 3. Selective read

Read the fields you need under a byte budget. Fields that do not fit are listed in
`omittedFields`; fetch them with the section reader, pinned to the same `snapshot`.

```sh recipe=selective-read track=cli capture=snapshot:snapshot
tracker issue view ENG-1 --fields title,description --max-bytes 4096 --json
```

```sh recipe=selective-read track=cli
tracker issue read-section ENG-1 --path description --snapshot <snapshot> --json
```

```json recipe=selective-read track=mcp capture=snapshot:snapshot
{ "tool": "get_issue", "arguments": { "identifier": "ENG-1", "fields": ["title", "description"], "maxBytes": 4096 } }
```

```json recipe=selective-read track=mcp
{ "tool": "read_issue_section", "arguments": { "identifier": "ENG-1", "path": ["description"], "snapshot": "<snapshot>" } }
```

## 4. Mutation

Claim the work, leave a comment with an idempotency key (a retry with the same key
returns the original comment), reread the revision, then update with
`expectedRevision` and a compact receipt. Reusing a revision you already spent fails
with `ISSUE_CONFLICT`.

```sh recipe=mutation track=cli
tracker issue claim ENG-1 --json
```

```sh recipe=mutation track=cli capture=commentId:id
tracker issue comment ENG-1 "Picked up; starting with the pipeline file." --idempotency-key eng-1-pickup --json
```

```sh recipe=mutation track=cli
tracker issue comment ENG-1 "Picked up; starting with the pipeline file." --idempotency-key eng-1-pickup --json
```

```sh recipe=mutation track=cli capture=revision:revision
tracker issue view ENG-1 --fields revision --json
```

```sh recipe=mutation track=cli
tracker issue update ENG-1 --expected-revision <revision> --title "Set up CI pipeline" --response compact --json
```

```sh recipe=mutation track=cli expect-error=ISSUE_CONFLICT
tracker issue update ENG-1 --expected-revision <revision> --priority 2 --response compact --json
```

```json recipe=mutation track=mcp
{ "tool": "claim_issue", "arguments": { "identifier": "ENG-1" } }
```

```json recipe=mutation track=mcp capture=commentId:id
{ "tool": "comment_on_issue", "arguments": { "issue": "ENG-1", "body": "Picked up; starting with the pipeline file.", "idempotencyKey": "eng-1-pickup" } }
```

```json recipe=mutation track=mcp
{ "tool": "comment_on_issue", "arguments": { "issue": "ENG-1", "body": "Picked up; starting with the pipeline file.", "idempotencyKey": "eng-1-pickup" } }
```

```json recipe=mutation track=mcp capture=revision:revision
{ "tool": "get_issue", "arguments": { "identifier": "ENG-1", "fields": ["revision"] } }
```

```json recipe=mutation track=mcp
{ "tool": "update_issue", "arguments": { "identifier": "ENG-1", "expectedRevision": "<revision>", "title": "Set up CI pipeline", "response": "compact" } }
```

```json recipe=mutation track=mcp expect-error=ISSUE_CONFLICT
{ "tool": "update_issue", "arguments": { "identifier": "ENG-1", "expectedRevision": "<revision>", "priority": 2, "response": "compact" } }
```

## 5. Incremental follow-up

Poll for what changed since the last `updatedAt` you saw, newest first, and follow
`nextCursor` until it is null.

```sh recipe=follow-up track=cli capture=cursor:nextCursor
tracker issue list --updated-since <since> --sort updatedAt --limit 2 --json
```

```sh recipe=follow-up track=cli capture=cursor:nextCursor repeat=cursor
tracker issue list --updated-since <since> --sort updatedAt --limit 2 --cursor <cursor> --json
```

```json recipe=follow-up track=mcp capture=cursor:nextCursor
{ "tool": "list_issues", "arguments": { "updatedSince": "<since>", "sort": "updatedAt", "limit": 2 } }
```

```json recipe=follow-up track=mcp capture=cursor:nextCursor repeat=cursor
{ "tool": "list_issues", "arguments": { "updatedSince": "<since>", "sort": "updatedAt", "limit": 2, "cursor": "<cursor>" } }
```

## Errors and retries

| Code | Meaning | What to do |
| --- | --- | --- |
| `ISSUE_CONFLICT` | `expectedRevision` is stale; `details.currentRevision` has the new one. | Reread the issue, then decide whether the change still applies. Do not resend blindly. |
| `ISSUE_CURSOR_STALE` | The result set changed under the cursor. | Restart without a cursor and dedupe identifiers you already processed. |
| `VALIDATION_FAILED` | The input is invalid (unknown field, bad date, conflicting flags). | Fix the input. Retrying the same input fails the same way. |
| Transport failure after a write | You cannot tell whether the write landed. | Retry with the same `idempotencyKey` (issue create, comments, links); a replay returns the original record. |

## CLI and MCP null aliases

| MCP argument | CLI flag |
| --- | --- |
| `assignee: null` | `--unassigned` |
| `project: null` | `--no-project` |
| `parent: null` | `--no-parent` |
| `ready: false` | `--not-ready` |

Each flag is mutually exclusive with its value form (`--assignee x --unassigned` is
`VALIDATION_FAILED`). `issue search` takes the query as a positional argument and has
no `--view`; to search inside a saved view use `issue list --view <name> --query <text>`
(MCP `list_issues {view, query}`).

## Don'ts

- Don't run an unbounded `issue list --json`; pass `--limit` and follow `nextCursor`.
- Don't call `describe` without `sections`; the full dump is for humans.
- Don't loop `get_issue` over a workspace; search or list with `fields` instead, and use
  `get_issues` for a handful of known identifiers.
- Don't read full issues to find one field; use `fields` and `maxBytes`.
