import { z } from "zod";

export const nonEmptyStringSchema = z.string().min(1);

export const optionalNullableStringSchema = z.string().min(1).nullable().optional();

export const optionalIntegerSchema = z.number().int().optional();

export const includeArchivedSchema = z.object({
  includeArchived: z.boolean().optional()
});
