import { z } from "zod";
export const toolProfileSchema = z.enum(["coding", "orchestration", "admin", "full"]);
export type ToolProfile = z.infer<typeof toolProfileSchema>;
