import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack` builds dist/cli.js, the `ottertrail-sourcemaps` command. It
  // uses Node.js built-ins only, so the bundle is the whole program.
  pack: {
    entry: { cli: "src/cli.ts" },
    platform: "node",
    format: "esm",
    // It runs in sites' own build pipelines: the oldest Node.js still supported.
    target: "node22",
    sourcemap: false,
    dts: false,
    outputOptions: { entryFileNames: "[name].js" },
  },
  test: {
    environment: "node",
  },
});
