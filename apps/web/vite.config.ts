import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins, type Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

import { chunkBudget } from "../../scripts/chunk-budget.ts";
import { thirdPartyLicenses } from "../../scripts/third-party-licenses.ts";

/**
 * The most JavaScript, in kB, a first visit may load before any page's own
 * chunk: the entry and what it imports statically (the shell, the router,
 * React, the shared UI). Set with a margin of about 12% over the size when
 * pages were split out; the build fails past it, giving the current size
 * (docs/dashboard.md, "Code splitting").
 */
const INITIAL_JS_BUDGET = { raw: 780, gzip: 255 };

const apiOrigin = process.env.OTTERTRAIL_API_ORIGIN ?? "http://127.0.0.1:3000";

/** The paths the API serves on the instance's own origin. */
const API_PATHS = ["/api", "/t.js", "/v.js", "/r.js", "/h.js", "/replay-player.js"];

/**
 * Under Vitest, the browser tests fake the API through fetch. A request the
 * fake does not see, such as the replay player's page in its iframe, must not
 * be forwarded to whatever else listens on the API's port on this machine,
 * and should not get the dashboard's own page either: this answers it at once
 * with a 404, as a missing API would.
 */
function noApiInTests(): Plugin {
  return {
    name: "ottertrail:no-api-in-tests",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        if (API_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
          response.statusCode = 404;
          response.setHeader("Content-Type", "text/plain");
          response.end("Not served in tests");
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: lazyPlugins(() => [
    react(),
    tailwindcss(),
    thirdPartyLicenses({
      stylesheets: [fileURLToPath(new URL("./src/styles/globals.css", import.meta.url))],
    }),
    chunkBudget(INITIAL_JS_BUDGET),
    ...(process.env.VITEST ? [noApiInTests()] : []),
  ]),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // The entry holds React DOM and the shell, about 510 kB. What a first
    // visit loads is held by INITIAL_JS_BUDGET, the check that counts, so
    // Vite warns only for a chunk well past the entry's size.
    chunkSizeWarningLimit: 600,
  },
  server: {
    // The API serves these on the instance's own origin; the dev server forwards
    // them. Not under Vitest (noApiInTests above).
    proxy: process.env.VITEST ? {} : Object.fromEntries(API_PATHS.map((path) => [path, apiOrigin])),
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/*.test.ts"], environment: "node" },
      },
      {
        // Pages rendered in headless Chromium, against a fake API (tests/browser/fake-api.ts).
        // Needs the browser once per machine: pnpm exec playwright install --only-shell chromium
        extends: true,
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.tsx"],
          setupFiles: ["tests/browser/setup.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            viewport: { width: 1280, height: 900 },
            commands: {
              /**
               * The device's color scheme, as `prefers-color-scheme` reads it: dark before
               * each test (tests/browser/setup.ts), light where a test asks.
               */
              async emulateColorScheme(context, scheme: "light" | "dark") {
                await context.page.emulateMedia({ colorScheme: scheme });
              },
            },
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
