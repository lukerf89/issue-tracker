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
  ...tseslint.configs.recommended
];
