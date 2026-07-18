import { eq } from "drizzle-orm";

import { inTransaction, type ServiceContext } from "../context.js";
import { actors, config, orchestrationProfiles, workspace } from "../db/schema.js";
import { AppError, AppErrorCode } from "../errors.js";
import { uuid } from "../ids.js";
import { ConfigKey, setConfigInTransaction } from "./config.js";
import { createTeamInTransaction } from "./team.js";
import { builtinProfileInput } from "./profile.js";

export interface InitInput {
  workspaceName?: string;
  teamKey?: string;
  teamName?: string;
  actorName?: string;
  actorHandle?: string;
}

export function init(context: ServiceContext, input: InitInput = {}) {
  return inTransaction(context, (txContext) => {
    const existingWorkspace = txContext.db.query.workspace.findFirst().sync();
    const existingDefaultTeam = txContext.db.query.config.findFirst({
      where: eq(config.key, ConfigKey.DEFAULT_TEAM)
    }).sync();
    const existingDefaultActor = txContext.db.query.config.findFirst({
      where: eq(config.key, ConfigKey.DEFAULT_ACTOR)
    }).sync();

    if (existingWorkspace || existingDefaultTeam || existingDefaultActor) {
      throw new AppError(
        AppErrorCode.ALREADY_INITIALIZED,
        "Issue tracker is already initialized."
      );
    }

    const now = txContext.clock.now().toISOString();
    const workspaceRow = {
      id: uuid(),
      name: input.workspaceName ?? "Local Workspace",
      createdAt: now,
      updatedAt: now
    };

    txContext.db.insert(workspace).values(workspaceRow).run();

    const team = createTeamInTransaction(txContext, {
      key: input.teamKey ?? "ENG",
      name: input.teamName ?? "Engineering"
    });

    const actor = {
      id: uuid(),
      type: "human" as const,
      name: input.actorName ?? "Human Owner",
      handle: input.actorHandle ?? "owner",
      archivedAt: null
    };

    txContext.db.insert(actors).values(actor).run();
    const profile = builtinProfileInput();
    txContext.db.insert(orchestrationProfiles).values({
      id: uuid(), name: profile.name, workflow: profile.workflow, schemaVersion: 1,
      configuration: profile.configuration, isDefault: true, isBuiltin: true,
      archivedAt: null, createdAt: now, updatedAt: now
    }).run();
    setConfigInTransaction(txContext, ConfigKey.DEFAULT_TEAM, team.id);
    setConfigInTransaction(txContext, ConfigKey.DEFAULT_ACTOR, actor.id);

    return { workspace: workspaceRow, team, actor };
  });
}
