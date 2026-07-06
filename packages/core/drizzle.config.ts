import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./src/migrations",
  schema: "./src/db/schema.ts",
  strict: true,
  verbose: true
});
