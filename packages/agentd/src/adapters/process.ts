import { spawn } from "node:child_process";

export async function runProcess(executable: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; stdin?: string; onProcess?: (pid: number) => void }) {
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid) options.onProcess?.(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    if (options.stdin) child.stdin.end(options.stdin); else child.stdin.end();
  });
}

export function parseJsonLines(text: string): unknown[] {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { type: "raw", text: line }; }
  });
}
