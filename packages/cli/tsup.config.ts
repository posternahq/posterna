import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: ["esm", "cjs"],
  // tsup 8 sets the deprecated baseUrl option when it builds type
  // declarations, which TypeScript 6 rejects. Silence that here only.
  dts: { entry: { index: "src/index.ts" }, compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  target: "node20",
});
