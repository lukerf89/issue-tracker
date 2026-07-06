import type { ServiceContext } from "../context.js";
import { activity } from "../db/schema.js";
import { uuid } from "../ids.js";

export interface AppendActivityInput {
  issueId: string;
  actorId: string;
  action: string;
  data: Record<string, unknown>;
}

export function appendActivity(context: ServiceContext, input: AppendActivityInput) {
  const now = context.clock.now().toISOString();
  const row = {
    id: uuid(),
    issueId: input.issueId,
    actorId: input.actorId,
    action: input.action,
    data: input.data,
    createdAt: now
  };

  context.db.insert(activity).values(row).run();
  return row;
}
