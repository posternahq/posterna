import { defineConfig } from "tsup";

// tsup 8 sets the deprecated baseUrl option when it builds type
// declarations, which TypeScript 6 rejects. Silence that here only.
const dts = { compilerOptions: { ignoreDeprecations: "6.0" } };

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    // import.meta.url in the CommonJS build (for createRequire).
    shims: true,
    dts,
    target: "node20",
  },
  {
    // The executable is ESM only: it uses top-level await.
    entry: { bin: "src/bin.ts" },
    format: ["esm"],
    target: "node20",
  },
]);
