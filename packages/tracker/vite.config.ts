import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack` builds dist/tracker.js: one minified script for a <script> tag.
  pack: {
    entry: { tracker: "src/script.ts" },
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    sourcemap: true,
    dts: false,
    // Named tracker.js instead of the default tracker.iife.js.
    outputOptions: { entryFileNames: "[name].js" },
  },
  // `vp dev` serves the playground in demo/ as a single-page app, with the
  // built dist/tracker.js available at /tracker.js.
  root: "demo",
  publicDir: "../dist",
  server: {
    open: "/",
  },
  test: {
    // Tests live in tests/, not under the playground's root.
    root: import.meta.dirname,
    environment: "node",
  },
});
