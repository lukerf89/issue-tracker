import { resolve } from "node:path";

import ts from "typescript";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: "node",
          // 120s (not 30s): several backend suites spawn CLI/MCP subprocesses (init +
          // stdio round-trips) that run in ~10-20s in isolation but can be starved past
          // 30s when all backend files run in parallel under CPU contention, producing
          // flaky "Test timed out in 30000ms" failures. A larger bound only affects
          // genuinely hung tests; healthy tests still finish fast.
          hookTimeout: 120000,
          include: ["packages/{core,cli,mcp,mcp-tool-filter,tui,agentd}/test/**/*.test.ts"],
          name: "backend",
          testTimeout: 120000
        }
      },
      {
        plugins: [reactTsxTransform()],
        resolve: {
          alias: {
            "server-only": resolve(import.meta.dirname, "packages/web/test/server-only.ts")
          }
        },
        test: {
          environment: "jsdom",
          hookTimeout: 30000,
          include: ["packages/web/test/**/*.test.{ts,tsx}"],
          name: "web",
          setupFiles: ["packages/web/test/setup.ts"],
          testTimeout: 30000
        }
      }
    ]
  }
});

function reactTsxTransform() {
  return {
    name: "react-tsx-transform",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.split("?")[0].endsWith(".tsx")) {
        return null;
      }

      const result = ts.transpileModule(code, {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          jsxImportSource: "react",
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2023
        }
      });

      return {
        code: result.outputText,
        map: null
      };
    }
  };
}
