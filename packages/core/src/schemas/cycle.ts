import { z } from "zod";

import type { CreateCycleInput, ListCyclesOptions } from "../services/cycle.js";
import { nonEmptyStringSchema, optionalIntegerSchema, optionalNullableStringSchema } from "./common.js";

export const cycleRefSchema = z.union([
  nonEmptyStringSchema,
  z.number().int().min(1)
]);

export const createCycleInputSchema = z.object({
  team: nonEmptyStringSchema.optional(),
  teamId: nonEmptyStringSchema.optional(),
  number: optionalIntegerSchema.pipe(z.number().int().min(1).optional()),
  name: optionalNullableStringSchema,
  startsAt: nonEmptyStringSchema.optional(),
  endsAt: nonEmptyStringSchema.optional()
}) satisfies z.ZodType<CreateCycleInput>;

export const listCyclesInputSchema = z.object({
  team: nonEmptyStringSchema.optional(),
  teamId: nonEmptyStringSchema.optional()
}) satisfies z.ZodType<ListCyclesOptions>;
