import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  define: {
    "process.env.MHUB_AGENT_ACTIVATION_API_URL": JSON.stringify(
      process.env.MHUB_AGENT_ACTIVATION_API_URL ?? "",
    ),
    "process.env.MHUB_RELAY_CONTROL_URL": JSON.stringify(process.env.MHUB_RELAY_CONTROL_URL ?? ""),
  },
  entry: ["src/main.ts", "src/preload.ts"],
  external: ["electron"],
  format: ["cjs"],
  noExternal: ["zod"],
  outDir: "dist",
  platform: "node",
});
