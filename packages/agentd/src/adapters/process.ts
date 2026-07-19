import { spawn } from "node:child_process";

import { wrapForSandbox, type ProviderSandbox } from "../sandbox.js";

export async function runProcess(executable: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; stdin?: string; onProcess?: (pid: number) => void; sandbox?: ProviderSandbox | null }) {
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const wrapped = options.sandbox ? wrapForSandbox({ executable, args, cwd: options.cwd, sandbox: options.sandbox }) : { executable, args, cleanup: () => {} };
    let child;
    try {
      child = spawn(wrapped.executable, wrapped.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      wrapped.cleanup();
      reject(error);
      return;
    }
    if (child.pid) options.onProcess?.(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { wrapped.cleanup(); reject(error); });
    child.on("close", (exitCode) => { wrapped.cleanup(); resolve({ exitCode, stdout, stderr }); });
    if (options.stdin) child.stdin.end(options.stdin); else child.stdin.end();
  });
}

export function parseJsonLines(text: string): unknown[] {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { type: "raw", text: line }; }
  });
}
