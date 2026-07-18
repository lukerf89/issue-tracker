import { resolve } from "node:path";

import ts from "typescript";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: "node",
          hookTimeout: 30000,
          include: ["packages/{core,cli,mcp,tui,agentd}/test/**/*.test.ts"],
          name: "backend",
          testTimeout: 30000
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
