import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { and, asc, eq, isNull } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { issueRepositories, projectRepositories, repositories } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { commandSpecSchema, type AddRepositoryInput, type AssociateRepositoryInput } from "../schemas/repository.js";
import { getIssue } from "./issue.js";
import { getProject } from "./project.js";

export interface RepositoryInspection {
  canonicalPath: string;
  commonDir: string;
  defaultBranch: string;
  headCommit: string;
  dirty: boolean;
  instructionFiles: string[];
  instructions: Record<string, string>;
}

export interface RepositoryInspector {
  inspect(path: string, baseRef?: string): RepositoryInspection;
}

export function createNodeRepositoryInspector(): RepositoryInspector {
  return {
    inspect(inputPath, baseRef) {
      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(inputPath);
      } catch {
        throw new AppError(AppErrorCode.REPOSITORY_INVALID, `Repository path ${inputPath} does not exist.`, { path: inputPath });
      }
      const git = (...args: string[]) => {
        try {
          return execFileSync("git", ["-C", canonicalPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        } catch {
          throw new AppError(AppErrorCode.REPOSITORY_INVALID, `${canonicalPath} is not a usable Git worktree.`, { path: canonicalPath });
        }
      };
      git("rev-parse", "--is-inside-work-tree");
      const commonDirRaw = git("rev-parse", "--git-common-dir");
      const commonDir = realpathSync(resolve(canonicalPath, commonDirRaw));
      const branch = baseRef ?? defaultBranch(git);
      const headCommit = git("rev-parse", `${branch}^{commit}`);
      const dirty = git("status", "--porcelain").length > 0;
      const instructionFiles = ["AGENTS.md", "CLAUDE.md"].filter((name) => {
        try { realpathSync(resolve(canonicalPath, name)); return true; } catch { return false; }
      });
      const instructions = Object.fromEntries(instructionFiles.map((name) => [name, readFileSync(resolve(canonicalPath, name), "utf8")]));
      return { canonicalPath, commonDir, defaultBranch: branch, headCommit, dirty, instructionFiles, instructions };
    }
  };
}

function defaultBranch(git: (...args: string[]) => string): string {
  try {
    const symbolic = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    return symbolic.replace(/^origin\//, "");
  } catch {
    return git("branch", "--show-current") || "main";
  }
}

export function addRepository(context: ServiceContext, rawInput: AddRepositoryInput, inspector: RepositoryInspector) {
  const input = { ...rawInput, setupCommand: rawInput.setupCommand ? commandSpecSchema.parse(rawInput.setupCommand) : null, testCommand: commandSpecSchema.parse(rawInput.testCommand), verificationCommand: commandSpecSchema.parse(rawInput.verificationCommand) };
  const inspected = inspector.inspect(input.path, input.defaultBranch);
  return inTransaction(context, (txContext) => {
    const duplicate = txContext.db.query.repositories.findFirst({
      where: eq(repositories.commonDir, inspected.commonDir)
    }).sync();
    if (duplicate) {
      throw new AppError(AppErrorCode.REPOSITORY_ALREADY_REGISTERED, `Repository ${duplicate.name} already represents this Git repository.`, { repositoryId: duplicate.id, commonDir: inspected.commonDir });
    }
    const timestamp = txContext.clock.now().toISOString();
    const row = {
      id: uuid(), name: input.name, canonicalPath: inspected.canonicalPath, commonDir: inspected.commonDir,
      defaultBranch: input.defaultBranch ?? inspected.defaultBranch, remote: input.remote ?? null,
      setupCommand: input.setupCommand, testCommand: input.testCommand, verificationCommand: input.verificationCommand,
      archivedAt: null, createdAt: timestamp, updatedAt: timestamp
    };
    txContext.db.insert(repositories).values(row).run();
    return parseRepository(row);
  });
}

export function listRepositories(context: ServiceContext, options: { includeArchived?: boolean } = {}) {
  return context.db.query.repositories.findMany({ where: options.includeArchived ? undefined : isNull(repositories.archivedAt), orderBy: [asc(repositories.name), asc(repositories.id)] }).sync().map(parseRepository);
}

export function getRepository(context: ServiceContext, idOrName: string) {
  const row = context.db.query.repositories.findFirst({ where: eq(repositories.id, idOrName) }).sync() ?? context.db.query.repositories.findFirst({ where: eq(repositories.name, idOrName) }).sync();
  if (!row) throw new AppError(AppErrorCode.REPOSITORY_NOT_FOUND, `Repository ${idOrName} was not found.`, { repository: idOrName });
  return parseRepository(row);
}

export function archiveRepository(context: ServiceContext, idOrName: string) {
  return inTransaction(context, (txContext) => {
    const repository = getRepository(txContext, idOrName);
    if (repository.archivedAt) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, `Repository ${repository.name} is already archived.`);
    txContext.db.update(repositories).set({ archivedAt: txContext.clock.now().toISOString(), updatedAt: txContext.clock.now().toISOString() }).where(eq(repositories.id, repository.id)).run();
    return getRepository(txContext, repository.id);
  });
}

export function associateRepository(context: ServiceContext, input: AssociateRepositoryInput) {
  return inTransaction(context, (txContext) => {
    const repository = getRepository(txContext, input.repository);
    if (repository.archivedAt) throw new AppError(AppErrorCode.REPOSITORY_ARCHIVED, `Repository ${repository.name} is archived.`);
    if (input.project) {
      const project = getProject(txContext, input.project);
      if (input.isDefault) txContext.db.update(projectRepositories).set({ isDefault: false }).where(eq(projectRepositories.projectId, project.id)).run();
      txContext.db.delete(projectRepositories).where(and(eq(projectRepositories.projectId, project.id), eq(projectRepositories.repositoryId, repository.id))).run();
      txContext.db.insert(projectRepositories).values({ projectId: project.id, repositoryId: repository.id, position: input.position, isDefault: input.isDefault }).run();
    } else {
      const issue = getIssue(txContext, input.issue!);
      txContext.db.delete(issueRepositories).where(and(eq(issueRepositories.issueId, issue.id), eq(issueRepositories.repositoryId, repository.id))).run();
      txContext.db.insert(issueRepositories).values({ issueId: issue.id, repositoryId: repository.id, position: input.position, overrideKind: input.overrideKind }).run();
    }
    return repository;
  });
}

export function resolveIssueRepositories(context: ServiceContext, issueRef: string) {
  const issue = getIssue(context, issueRef);
  const overrides = context.db.select({ repository: repositories, position: issueRepositories.position }).from(issueRepositories).innerJoin(repositories, eq(issueRepositories.repositoryId, repositories.id)).where(and(eq(issueRepositories.issueId, issue.id), isNull(repositories.archivedAt))).orderBy(asc(issueRepositories.position), asc(repositories.id)).all();
  if (overrides.length > 0) return overrides.map(({ repository }) => parseRepository(repository));
  if (!issue.projectId) return [];
  return context.db.select({ repository: repositories, position: projectRepositories.position, isDefault: projectRepositories.isDefault }).from(projectRepositories).innerJoin(repositories, eq(projectRepositories.repositoryId, repositories.id)).where(and(eq(projectRepositories.projectId, issue.projectId), isNull(repositories.archivedAt))).orderBy(asc(projectRepositories.position), asc(repositories.id)).all().map(({ repository }) => parseRepository(repository));
}

function parseRepository<T extends { setupCommand: unknown; testCommand: unknown; verificationCommand: unknown }>(row: T) {
  const setup = row.setupCommand === null ? { success: true as const, data: null } : commandSpecSchema.safeParse(row.setupCommand);
  const test = commandSpecSchema.safeParse(row.testCommand);
  const verification = commandSpecSchema.safeParse(row.verificationCommand);
  if (!setup.success || !test.success || !verification.success) throw new AppError(AppErrorCode.DATA_INTEGRITY, "Stored repository command configuration is invalid.", { setup: setup.success ? null : setup.error.issues, test: test.success ? null : test.error.issues, verification: verification.success ? null : verification.error.issues });
  return { ...row, setupCommand: setup.data, testCommand: test.data, verificationCommand: verification.data };
}
