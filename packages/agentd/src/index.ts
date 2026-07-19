#!/usr/bin/env node
export { Supervisor, type SupervisorOptions } from "./supervisor.js";
export { WorktreeManager, type WorktreeSpec } from "./worktrees.js";
export { executeCommand } from "./commands.js";
export { writePrivateLog, sha256File } from "./artifacts.js";
export { FakeProviderAdapter, type FakeProviderScript } from "./adapters/fake.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export { CodexAdapter } from "./adapters/codex.js";
export type { ProviderAdapter, ProviderCapabilities, ProviderEvent, ProviderLaunch, ProviderResult } from "./adapters/contract.js";
export { publishDraftPullRequest, type PublishDraftInput } from "./publishers/github-cli.js";
export { runAgentd } from "./main.js";

import { runAgentd } from "./main.js";

const entrypoint = process.argv[1] && /(?:^|\/)index\.(?:js|ts)$/.test(process.argv[1]) && import.meta.url === new URL(process.argv[1], "file:").href;
if (entrypoint) void runAgentd();
