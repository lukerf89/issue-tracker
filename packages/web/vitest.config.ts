import { resolve } from "node:path";

import ts from "typescript";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [reactTsxTransform()],
  resolve: {
    alias: {
      "server-only": resolve(import.meta.dirname, "test/server-only.ts")
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"]
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
