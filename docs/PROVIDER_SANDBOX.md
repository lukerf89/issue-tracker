# Provider OS Sandbox

The provider permission hook and the macOS Seatbelt jail enforce different boundaries. The hook is
trusted to adjudicate mutating tool calls at the policy layer and to record durable operator
decisions. It is still required for autonomous Claude Code. Policy code can fail open when buggy,
however, and review has found two read bypasses in that layer.

The optional Seatbelt profile enforces a kernel-level read boundary. An approved-but-malicious or
ungated read can access the worktree and allowlisted toolchain paths, but cannot read host secrets
such as `~/.ssh/git-signing-key`, `~/.aws/credentials`, or arbitrary files elsewhere in the home
directory.

`ISSUE_TRACKER_DB` is not a secret hidden from the provider jail. It is the sanctioned control
channel used by the confined permission-hook child, which must read and write the database and its
SQLite `-wal` and `-shm` sidecars. The profile deliberately grants access to the database directory.
The meaningful confidentiality boundary protects unrelated host data such as `~/.ssh` and
`~/.aws`.

Set an engine's `osSandbox` option to `true` to enable the jail. It is opt-in, defaults to off, and
is a clean no-op outside macOS or when `/usr/bin/sandbox-exec` is unavailable. Seatbelt compares
canonical paths, so the worktree, temporary directory, toolchain paths, hook installation root, and
database directory are resolved through `realpath` before the profile is emitted. This is required
for aliases such as `/tmp` and `/var/folders`, whose canonical locations live under `/private`.

Seatbelt confinement is inherited by the permission-hook child and every provider subprocess,
including `git`, `npm`, and `node`. The allowlist therefore covers the provider and Node prefixes,
system libraries, package-manager state, Claude Code authentication support, the hook installation,
and the tracker database directory.

Residual gaps remain. The provider retains outbound network access and macOS Keychain-related read
and service access so it can reach and authenticate to the model API. Claude Code can write its
`~/.claude` state directory for transcripts, todos, and runtime telemetry. Codex also retains its own
orthogonal `--sandbox` layer; fully enumerating the read paths used by Codex's Seatbelt helper is
follow-up work.
