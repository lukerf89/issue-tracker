import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: "node",
          include: ["packages/{core,cli,mcp}/test/**/*.test.ts"],
          name: "backend"
        }
      },
      {
        resolve: {
          alias: {
            "server-only": resolve(import.meta.dirname, "packages/web/test/server-only.ts")
          }
        },
        test: {
          environment: "jsdom",
          include: ["packages/web/test/**/*.test.{ts,tsx}"],
          name: "web",
          setupFiles: ["packages/web/test/setup.ts"]
        }
      }
    ]
  }
});
