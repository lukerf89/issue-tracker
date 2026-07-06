# issue-tracker

A local-only, agent-native issue tracker over SQLite. It provides a `tracker` CLI for
humans and an MCP server for agents, both backed by the same core services and database.

M0 is intentionally small: initialize a local database, manage teams and projects, create
and move issues, list or view records as JSON, and expose the same records through MCP.

## Install

Requirements:

- Node.js 22 or newer
- npm

From a checkout:

```sh
npm install
npm run build
npm link --workspace @issue-tracker/cli
```

After linking, the `tracker` command is available on your PATH.

## Quickstart

Use `--db` while trying the tool so you do not touch any default local database:

```sh
DB=/tmp/issue-tracker-demo/tracker.db

tracker --db "$DB" init
tracker --db "$DB" project create "Platform Foundations" --status planned
tracker --db "$DB" issue create --title "Set up CI" --project "Platform Foundations" --priority 2
tracker --db "$DB" issue list --json
tracker --db "$DB" issue move ENG-1 "In Progress"
tracker --db "$DB" issue move ENG-1 Done
tracker --db "$DB" issue view ENG-1 --json
```

The first issue on the default seeded `ENG` team is `ENG-1` with the title
`"Set up CI"`.

## M0 Commands

Global options can be placed before any command:

```text
tracker [--db <path>] [--json] [--team <key>] <command>
```

Workspace and configuration:

```text
tracker init [--workspace <name>] [--team-key <key>] [--team-name <name>] [--actor-name <name>] [--actor-handle <handle>]
tracker whoami
tracker config get <key>
tracker config set <key> <value>
```

Teams:

```text
tracker team create <key> <name>
tracker team list [--include-archived]
```

Projects:

```text
tracker project create [name] [--name <name>] [--desc <description>] [--status <status>]
tracker project list [--include-archived]
tracker project view <project>
tracker project update <project> [--name <name>] [--desc <description>] [--status <status>]
```

Issues:

```text
tracker issue create [title] [--title <title>] [--desc <description>] [--team <key>] [--project <project>] [--priority <number>] [--assignee <actor>] [--state <state>]
tracker issue list [--state <state>] [--assignee <actor>] [--unassigned] [--project <project>] [--no-project] [--priority <number>] [--team <key>] [--limit <number>] [--include-archived]
tracker issue view <identifier>
tracker issue update <identifier> [--title <title>] [--desc <description>] [--priority <number>] [--assignee <actor>] [--unassigned] [--project <project>] [--no-project] [--estimate <number>] [--due-date <date>]
tracker issue move <identifier> <state>
```

Every read command accepts `--json`. Mutations that return a record also accept `--json`.

## MCP

Run the MCP server over stdio with the same database:

```sh
tracker --db /tmp/issue-tracker-demo/tracker.db mcp --agent build-agent
```

Point an MCP client at that command. For example:

```json
{
  "mcpServers": {
    "issue-tracker": {
      "command": "tracker",
      "args": [
        "--db",
        "/tmp/issue-tracker-demo/tracker.db",
        "mcp",
        "--agent",
        "build-agent"
      ]
    }
  }
}
```

M0 tools are `list_issues`, `get_issue`, `create_issue`, `update_issue`, `move_issue`,
`list_projects`, `get_project`, `create_project`, and `list_teams`.

## Privacy

The SQLite database is local and gitignored. Keep examples fictional; this README uses
the fictional issue `ENG-1 "Set up CI"`.
