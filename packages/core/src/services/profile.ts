import { asc, eq, isNull } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { orchestrationProfiles } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { profileConfigurationSchema, type AddProfileInput } from "../schemas/profile.js";

export const BUILTIN_PROFILE_NAME = "issue-delivery";

export function builtinProfileInput(): AddProfileInput {
  return {
    name: BUILTIN_PROFILE_NAME,
    workflow: "issue-delivery",
    configuration: profileConfigurationSchema.parse({
      roles: {
        orchestrator: "claude-default", planner: "claude-default", implementer: "claude-default",
        verifier: "claude-default", bindingReviewer: "claude-default", adversarialReviewer: "claude-default"
      },
      permissionPolicy: "worktree-autonomous",
      pushPolicy: "approved",
      draftPrPolicy: "approved",
      issueStartedState: "__started__"
    }),
    isDefault: true
  };
}

export function ensureBuiltinProfile(context: ServiceContext) {
  const existing = context.db.query.orchestrationProfiles.findFirst({ where: eq(orchestrationProfiles.name, BUILTIN_PROFILE_NAME) }).sync();
  if (existing) return parseProfile(existing);
  return createProfileRow(context, builtinProfileInput(), true);
}

export function addProfile(context: ServiceContext, input: AddProfileInput) {
  return createProfileRow(context, input, false);
}

function createProfileRow(context: ServiceContext, input: AddProfileInput, isBuiltin: boolean) {
  return inTransaction(context, (txContext) => {
    const configuration = profileConfigurationSchema.parse(input.configuration);
    if (input.isDefault) txContext.db.update(orchestrationProfiles).set({ isDefault: false }).run();
    const now = txContext.clock.now().toISOString();
    const row = { id: uuid(), name: input.name, workflow: input.workflow, schemaVersion: 1, configuration, isDefault: input.isDefault, isBuiltin, archivedAt: null, createdAt: now, updatedAt: now };
    txContext.db.insert(orchestrationProfiles).values(row).run();
    return parseProfile(row);
  });
}

export function listProfiles(context: ServiceContext, options: { includeArchived?: boolean } = {}) {
  return context.db.query.orchestrationProfiles.findMany({ where: options.includeArchived ? undefined : isNull(orchestrationProfiles.archivedAt), orderBy: [asc(orchestrationProfiles.name), asc(orchestrationProfiles.id)] }).sync().map(parseProfile);
}

export function getProfile(context: ServiceContext, idOrName?: string) {
  const row = idOrName
    ? context.db.query.orchestrationProfiles.findFirst({ where: eq(orchestrationProfiles.id, idOrName) }).sync() ?? context.db.query.orchestrationProfiles.findFirst({ where: eq(orchestrationProfiles.name, idOrName) }).sync()
    : context.db.query.orchestrationProfiles.findFirst({ where: eq(orchestrationProfiles.isDefault, true) }).sync();
  if (!row) throw new AppError(AppErrorCode.PROFILE_NOT_FOUND, `Orchestration profile ${idOrName ?? "default"} was not found.`, { profile: idOrName ?? null });
  return parseProfile(row);
}

export function archiveProfile(context: ServiceContext, idOrName: string) {
  return inTransaction(context, (txContext) => {
    const profile = getProfile(txContext, idOrName);
    if (profile.isBuiltin) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "The built-in profile cannot be archived.");
    const now = txContext.clock.now().toISOString();
    txContext.db.update(orchestrationProfiles).set({ archivedAt: now, isDefault: false, updatedAt: now }).where(eq(orchestrationProfiles.id, profile.id)).run();
    return getProfile(txContext, profile.id);
  });
}

export function setDefaultProfile(context: ServiceContext, idOrName: string) {
  return inTransaction(context, (txContext) => {
    const profile = getProfile(txContext, idOrName);
    if (profile.archivedAt) throw new AppError(AppErrorCode.CONSTRAINT_VIOLATION, "An archived profile cannot be the default.");
    txContext.db.update(orchestrationProfiles).set({ isDefault: false }).run();
    txContext.db.update(orchestrationProfiles).set({ isDefault: true, updatedAt: txContext.clock.now().toISOString() }).where(eq(orchestrationProfiles.id, profile.id)).run();
    return getProfile(txContext, profile.id);
  });
}

function parseProfile<T extends { configuration: unknown }>(row: T) {
  const parsed = profileConfigurationSchema.safeParse(row.configuration);
  if (!parsed.success) throw new AppError(AppErrorCode.DATA_INTEGRITY, "Stored orchestration profile configuration is invalid.", { issues: parsed.error.issues });
  return { ...row, configuration: parsed.data };
}
