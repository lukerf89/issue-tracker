#!/usr/bin/env node
export { filterToolsListResponse } from "./filterToolsListResponse.js";
export { ORCHESTRATION_TOOL_NAMES, ORCHESTRATION_TOOL_NAME_SET } from "./orchestrationTools.js";
export { runProxy, type RunProxyOptions } from "./proxy.js";

import { runProxy } from "./proxy.js";

const entrypoint =
  process.argv[1] !== undefined &&
  /(?:^|\/)index\.(?:js|ts)$/.test(process.argv[1]) &&
  import.meta.url === new URL(process.argv[1], "file:").href;

if (entrypoint) {
  // TRACKER_CLI_ENTRY lets tests (and anyone building tracker from source
  // rather than installing it globally) point the proxy at a specific built
  // CLI entrypoint instead of resolving "tracker" from PATH.
  const trackerCliEntry = process.env.TRACKER_CLI_ENTRY;
  const { command, args } = trackerCliEntry
    ? { command: process.execPath, args: [trackerCliEntry, ...process.argv.slice(2)] }
    : { command: "tracker", args: process.argv.slice(2) };

  const exitCode = await runProxy({ command, args });
  process.exitCode = exitCode;
}
