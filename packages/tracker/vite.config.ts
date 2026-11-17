import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

/** The scripts a site loads, each its own build: a script tag takes one file. */
const scripts = {
  // The script tag's file.
  tracker: { entry: "src/script.ts" },
  // Web Vitals, loaded by the tracker from beside itself.
  v: {
    entry: "src/vitals.ts",
    banner:
      "/*! web-vitals, Copyright 2020 Google LLC, Apache License 2.0: https://github.com/GoogleChrome/web-vitals/blob/main/LICENSE */",
  },
  // Session replay around errors, loaded by the tracker with data-replay="errors".
  r: {
    entry: "src/replay.ts",
    banner:
      "/*! rrweb, Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors), MIT License: https://github.com/rrweb-io/rrweb/blob/master/LICENSE */\n" +
      "/*! base64-arraybuffer, Copyright (c) 2012 Niklas von Hertzen, MIT License: https://github.com/niklasvh/base64-arraybuffer/blob/master/LICENSE-MIT */",
  },
};

export default defineConfig({
  // `vp pack` builds three minified scripts: dist/tracker.js for a <script>
  // tag, and dist/v.js and dist/r.js, which it loads from beside itself.
  pack: Object.entries(scripts).map(([name, script]) => ({
    entry: { [name]: script.entry },
    format: "iife" as const,
    platform: "browser" as const,
    target: "es2020",
    minify: true,
    sourcemap: true,
    dts: false,
    // A later build must not empty dist/ of the first.
    clean: name === "tracker",
    // A browser script has no node_modules: put the library in it.
    deps: { alwaysBundle: [/./] },
    // The library's license asks for its notice to go with it.
    ...("banner" in script ? { banner: script.banner } : {}),
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
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/*.test.ts"], environment: "node" },
      },
      {
        // The replay recorder in headless Chromium, with the real rrweb.
        // Needs the browser once per machine: pnpm exec playwright install --only-shell chromium
        extends: true,
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            viewport: { width: 1280, height: 900 },
            instances: [{ browser: "chromium" }],
            commands: {
              // Joined gzip pieces decompressed as the API does, with Node's zlib:
              // the browser's DecompressionStream takes one gzip member only.
              gunzip: (_context, base64: string) =>
                gunzipSync(Buffer.from(base64, "base64")).toString("utf8"),
            },
          },
        },
      },
    ],
  },
});
