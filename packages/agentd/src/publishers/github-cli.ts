import { execFile } from "node:child_process";

export interface PublishDraftInput { cwd: string; title: string; body: string; base: string; head: string }

export async function publishDraftPullRequest(input: PublishDraftInput) {
  const output = await exec("gh", ["pr", "create", "--draft", "--title", input.title, "--body", input.body, "--base", input.base, "--head", input.head], input.cwd);
  const url = output.trim().split(/\r?\n/).at(-1);
  if (!url?.startsWith("http")) throw new Error(`GitHub CLI did not return a pull request URL: ${output}`);
  return { url };
}

function exec(executable: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => execFile(executable, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
}
