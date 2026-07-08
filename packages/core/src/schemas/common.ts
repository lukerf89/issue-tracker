import { z } from "zod";

export const nonEmptyStringSchema = z.string().min(1);

export const optionalNullableStringSchema = z.string().min(1).nullable().optional();

export const optionalIntegerSchema = z.number().int().optional();

export const dateOnlyStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  },
  { message: "Expected a valid date in YYYY-MM-DD format." }
);

export const optionalNullableDateOnlyStringSchema = dateOnlyStringSchema.nullable().optional();

export const includeArchivedSchema = z.object({
  includeArchived: z.boolean().optional()
});
