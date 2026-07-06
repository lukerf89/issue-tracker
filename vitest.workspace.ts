import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      include: ["packages/*/test/**/*.test.ts"],
      name: "packages"
    }
  }
]);
