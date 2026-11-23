import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

const RRWEB_BANNER =
  "/*! rrweb, Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors), MIT License: https://github.com/rrweb-io/rrweb/blob/master/LICENSE */\n" +
  "/*! base64-arraybuffer, Copyright (c) 2012 Niklas von Hertzen, MIT License: https://github.com/niklasvh/base64-arraybuffer/blob/master/LICENSE-MIT */";

/** The scripts a site loads, each its own build: a script tag takes one file. */
const scripts = {
  tracker: { entry: "src/script.ts" },
  // Web Vitals, loaded by the tracker from beside itself.
  v: {
    entry: "src/vitals.ts",
    banner:
      "/*! web-vitals, Copyright 2020 Google LLC, Apache License 2.0: https://github.com/GoogleChrome/web-vitals/blob/main/LICENSE */",
  },
  // Session replay around errors, loaded by the tracker with data-replay="errors".
  r: { entry: "src/replay.ts", banner: RRWEB_BANNER },
  // Heatmap capture, loaded by the tracker with data-heatmaps="on".
  h: { entry: "src/heatmaps.ts" },
  // The heatmap overlay, loaded by the tracker on a page opened from the dashboard.
  o: { entry: "src/overlay.ts" },
  // A saved heatmap view, loaded by o.js when the owner presses "Save this view".
  s: { entry: "src/snapshot.ts", banner: RRWEB_BANNER },
};

// GitHub's runner for a private repository has 2 CPUs, against 14 threads
// locally: in CI (CI=true) tests and waits get longer limits.
const CI = process.env.CI === "true";

export default defineConfig({
  // Keep each script in one file for loading by script tag.
  pack: Object.entries(scripts).map(([name, script]) => ({
    entry: { [name]: script.entry },
    format: "iife" as const,
    platform: "browser" as const,
    target: "es2020",
    minify: true,
    sourcemap: true,
    dts: false,
    // Preserve earlier scripts when building the rest.
    clean: name === "tracker",
    // Bundle dependencies for direct browser use.
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
    ...(CI ? { testTimeout: 60_000, expect: { poll: { timeout: 5_000 } } } : {}),
    // Tests live in tests/, not under the playground's root.
    root: import.meta.dirname,
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/*.test.ts"], environment: "node" },
      },
      {
        // Install Chromium once: pnpm exec playwright install --only-shell chromium
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
              // Use Node zlib for joined gzip members; DecompressionStream reads only one.
              gunzip: (_context, base64: string) =>
                gunzipSync(Buffer.from(base64, "base64")).toString("utf8"),
            },
          },
        },
      },
    ],
  },
});
