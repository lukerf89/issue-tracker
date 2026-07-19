import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { CommandSpec } from "@issue-tracker/core";

export async function executeCommand(spec: CommandSpec, options: { cwd: string; logPath: string; environment?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: "a", mode: 0o600 });
  const startedAt = new Date().toISOString();
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const env = Object.fromEntries(spec.envNames.filter((name) => options.environment?.[name] !== undefined).map((name) => [name, options.environment![name]]));
    const child = spawn(spec.executable, spec.args, { cwd: options.cwd, env: { PATH: options.environment?.PATH ?? process.env.PATH, ...env }, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const completedAt = new Date().toISOString();
  await new Promise<void>((resolveClose) => log.end(resolveClose));
  return { ...result, startedAt, completedAt, logPath: options.logPath };
}
