import { z } from "zod";
export const toolProfileSchema = z.enum(["coding", "orchestration", "admin", "full"]);
export type ToolProfile = z.infer<typeof toolProfileSchema>;

/** Groups a registered MCP tool belongs to; profiles advertise tools by group. */
export const toolGroupSchema = z.enum(["coding", "orchestration", "admin"]);
export type ToolGroup = z.infer<typeof toolGroupSchema>;
export const TOOL_GROUPS_META_KEY = "issue-tracker/groups";

/** Registration metadata for a tool. Typed and checked, so a typo or an empty list cannot silently drop a tool from every profile. */
export function toolGroups(...groups: [ToolGroup, ...ToolGroup[]]): { [TOOL_GROUPS_META_KEY]: ToolGroup[] } {
  return { [TOOL_GROUPS_META_KEY]: z.array(toolGroupSchema).min(1).parse(groups) };
}

/**
 * Whether a profile advertises a tool with these registration groups. `full` and
 * `admin` advertise everything; `orchestration` includes the coding tools.
 */
export function isToolAdvertised(profile: ToolProfile, meta: Record<string, unknown> | undefined): boolean {
  if (profile === "full" || profile === "admin") return true;
  const groups = meta?.[TOOL_GROUPS_META_KEY];
  if (!Array.isArray(groups)) return false;
  return groups.includes(profile) || (profile === "orchestration" && groups.includes("coding"));
}
