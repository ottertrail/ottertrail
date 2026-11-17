import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack` builds two minified scripts: dist/tracker.js for a <script>
  // tag, and dist/v.js, the Web Vitals script it loads from beside itself
  // (src/vitals.ts). Separate builds: a script tag takes one file each.
  pack: ["tracker", "v"].map((name) => ({
    entry: { [name]: name === "tracker" ? "src/script.ts" : "src/vitals.ts" },
    format: "iife" as const,
    platform: "browser" as const,
    target: "es2020",
    minify: true,
    sourcemap: true,
    dts: false,
    // The second build must not empty dist/ of the first.
    clean: name === "tracker",
    // A browser script has no node_modules: put the library in it.
    deps: { alwaysBundle: [/./] },
    // The library's license asks for its notice to go with it.
    ...(name === "v"
      ? {
          banner:
            "/*! web-vitals, Copyright 2020 Google LLC, Apache License 2.0: https://github.com/GoogleChrome/web-vitals/blob/main/LICENSE */",
        }
      : {}),
    // Named tracker.js instead of the default tracker.iife.js.
    outputOptions: { entryFileNames: "[name].js" },
  })),
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
