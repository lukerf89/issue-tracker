import { spawn } from "node:child_process";

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

import { filterToolsListResponse } from "./filterToolsListResponse.js";

export interface RunProxyOptions {
  /** The real tracker executable to spawn (e.g. "tracker"). */
  command: string;
  /** Argv to forward unmodified to the real tracker MCP server. */
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Overridable for tests; defaults to the real process streams. */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * Spawns the real tracker MCP server as a child process and relays JSON-RPC
 * stdio traffic between it and the given client streams (defaulting to this
 * process's own stdin/stdout/stderr).
 *
 * - Client -> server (stdin) is piped through raw and unmodified.
 * - Server -> client (stdout) is parsed as newline-delimited JSON-RPC using
 *   the MCP SDK's own line-framing primitives, run through
 *   `filterToolsListResponse` (a no-op for every message except a
 *   `tools/list` response), re-serialized with the SDK's own serializer, and
 *   written back out. Backpressure on the outbound write is respected.
 * - Child stderr is forwarded untouched.
 *
 * Resolves with the child's exit code once the child process exits.
 */
export function runProxy(options: RunProxyOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const child = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env ?? process.env
  });

  // Client -> server: raw passthrough, no filtering needed in this direction.
  stdin.pipe(child.stdin);

  if (child.stderr) {
    child.stderr.pipe(stderr as NodeJS.WritableStream);
  }

  const readBuffer = new ReadBuffer();

  child.stdout?.on("data", (chunk: Buffer) => {
    readBuffer.append(chunk);
    drainBuffer();
  });

  function drainBuffer(): void {
    while (true) {
      let message;

      try {
        message = readBuffer.readMessage();
      } catch (error) {
        stderr.write(`[mcp-tool-filter] failed to parse message from server: ${String(error)}\n`);
        // The buffer position already advanced past the offending line inside
        // readMessage(); continue draining rather than dropping the connection.
        continue;
      }

      if (message === null) {
        break;
      }

      const filtered = filterToolsListResponse(message);
      const shouldContinue = stdout.write(serializeMessage(filtered));

      if (!shouldContinue) {
        child.stdout?.pause();
        stdout.once("drain", () => {
          child.stdout?.resume();
        });
      }
    }
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  });
}
