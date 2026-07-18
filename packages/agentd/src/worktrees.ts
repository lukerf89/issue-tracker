import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export interface WorktreeSpec { repositoryPath: string; worktreePath: string; branch: string; baseCommit: string }

export class WorktreeManager {
  constructor(readonly managedRoot: string) {}

  provision(spec: WorktreeSpec) {
    this.assertManaged(spec.worktreePath);
    if (existsSync(spec.worktreePath)) {
      const actualCommit = this.git(spec.worktreePath, "rev-parse", "HEAD");
      const actualBranch = this.git(spec.worktreePath, "branch", "--show-current");
      if (actualBranch !== spec.branch) throw new Error(`Existing worktree ${spec.worktreePath} belongs to branch ${actualBranch}, not ${spec.branch}.`);
      return { adopted: true, path: realpathSync(spec.worktreePath), branch: actualBranch, commit: actualCommit };
    }
    mkdirSync(dirname(spec.worktreePath), { recursive: true });
    try {
      execFileSync("git", ["-C", spec.repositoryPath, "worktree", "add", "-b", spec.branch, spec.worktreePath, spec.baseCommit], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const existingBranch = this.tryGit(spec.repositoryPath, "rev-parse", `refs/heads/${spec.branch}`);
      if (existingBranch !== spec.baseCommit) throw error;
      execFileSync("git", ["-C", spec.repositoryPath, "worktree", "add", spec.worktreePath, spec.branch], { stdio: ["ignore", "pipe", "pipe"] });
    }
    return { adopted: false, path: realpathSync(spec.worktreePath), branch: spec.branch, commit: this.git(spec.worktreePath, "rev-parse", "HEAD") };
  }

  remove(spec: { repositoryPath: string; worktreePath: string; allowUnmerged?: boolean; active?: boolean }) {
    this.assertManaged(spec.worktreePath);
    if (spec.active) throw new Error("An active worktree cannot be removed.");
    if (!spec.allowUnmerged) {
      const head = this.git(spec.worktreePath, "rev-parse", "HEAD");
      const merged = this.git(spec.repositoryPath, "branch", "--merged", "HEAD").split(/\r?\n/).some((line) => line.trim().replace(/^\* /, "") === this.git(spec.worktreePath, "branch", "--show-current"));
      if (!merged) throw new Error(`Worktree commit ${head} is unmerged.`);
    }
    execFileSync("git", ["-C", spec.repositoryPath, "worktree", "remove", spec.worktreePath], { stdio: ["ignore", "pipe", "pipe"] });
    if (existsSync(spec.worktreePath)) rmSync(spec.worktreePath, { recursive: true, force: true });
  }

  assertManaged(path: string) {
    const root = resolve(this.managedRoot);
    const target = resolve(path);
    const relation = relative(root, target);
    if (!relation || relation.startsWith("..") || relation.startsWith("/")) throw new Error(`Cleanup target ${target} is outside or equal to the managed root ${root}.`);
  }

  private git(cwd: string, ...args: string[]) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  private tryGit(cwd: string, ...args: string[]) { try { return this.git(cwd, ...args); } catch { return null; } }
}
