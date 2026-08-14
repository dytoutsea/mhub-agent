import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: ["src/main.ts", "src/preload.ts"],
  external: ["electron"],
  format: ["cjs"],
  noExternal: ["zod"],
  outDir: "dist",
  platform: "node",
});
