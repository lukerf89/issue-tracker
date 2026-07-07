#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

step() {
  printf '\n==> %s\n' "$1"
}

require_node_22() {
  if ! command -v node >/dev/null 2>&1; then
    printf 'Node.js 22 or newer is required, but node was not found on PATH.\n' >&2
    exit 1
  fi

  local version major
  version="$(node -v)"
  major="${version#v}"
  major="${major%%.*}"

  if [[ ! "$major" =~ ^[0-9]+$ ]] || (( major < 22 )); then
    printf 'Node.js 22 or newer is required, but found %s.\n' "$version" >&2
    exit 1
  fi
}

resolve_db_path() {
  if [[ -n "${ISSUE_TRACKER_DB:-}" ]]; then
    printf '%s\n' "$ISSUE_TRACKER_DB"
    return
  fi

  local data_home
  data_home="${XDG_DATA_HOME:-${HOME:?HOME must be set when ISSUE_TRACKER_DB is unset}/.local/share}"
  printf '%s\n' "$data_home/issue-tracker/tracker.db"
}

cd "$repo_root"

step "Checking Node.js version"
require_node_22

step "Installing dependencies"
npm install

step "Building workspaces"
npm run build

step "Linking tracker CLI"
npm link --workspace @issue-tracker/cli
hash -r 2>/dev/null || true

db_path="$(resolve_db_path)"
step "Using database path"
printf '%s\n' "$db_path"

if [[ -f "$db_path" ]]; then
  step "Database already exists; skipping tracker init"
else
  step "Initializing issue-tracker database"
  tracker init
fi

cat <<'EOF'

Next steps:
  1. Create a project:
     tracker project create "Platform Foundations" --status planned
  2. Open Linekeeper:
     tracker tui
  3. Run the web UI:
     npm run dev -w @issue-tracker/web
  4. Wire Claude Code:
     claude mcp add issue-tracker -- tracker mcp --agent claude-code
EOF
