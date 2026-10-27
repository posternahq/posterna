import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/config.ts"],
  format: ["esm", "cjs"],
  // tsup 8 sets the deprecated baseUrl option when it builds type
  // declarations, which TypeScript 6 rejects. Silence that here only.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  target: "node20",
});
