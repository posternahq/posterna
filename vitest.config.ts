import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Unit tests run against core's source, so they need no build first.
    alias: {
      "@posterna/core": fileURLToPath(new URL("packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/scripts/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "test/*.test.ts",
    ],
    // End-to-end tests start the example apps from built packages: `pnpm test:e2e`.
    exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**"],
  },
});
