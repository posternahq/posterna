import { defineConfig } from "vitest/config";

// End-to-end tests: start each example app from the built packages and talk to
// it over HTTP, with a mock ingest server standing in for the Posterna cloud.
// Run `pnpm build` first.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
