import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "node_modules/**",
      "coverage/**",
      ".vitest/**",
      "**/*.tsbuildinfo"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/agentd/src/**/*.ts", "packages/cli/src/**/*.ts", "packages/mcp/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@issue-tracker/core/*"], message: "Adapters must use the public @issue-tracker/core barrel." },
          { group: ["drizzle-orm", "drizzle-orm/*"], message: "Database and business logic belong in core services." }
        ]
      }]
    }
  }
];
