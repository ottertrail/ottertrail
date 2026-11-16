import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/server.ts", "src/worker.ts", "src/migrate.ts"],
    platform: "node",
    format: "esm",
    sourcemap: true,
    dts: false,
  },
  test: {
    environment: "node",
  },
});
