import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins, type Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

import { chunkBudget } from "../../scripts/chunk-budget.ts";
import { thirdPartyLicenses } from "../../scripts/third-party-licenses.ts";

/**
 * Initial JavaScript limits in kB, including the entry and static imports.
 * The build fails above these limits (docs/dashboard.md, "Code splitting").
 */
const INITIAL_JS_BUDGET = { raw: 780, gzip: 255 };

const apiOrigin = process.env.OTTERTRAIL_API_ORIGIN ?? "http://127.0.0.1:3000";

const API_PATHS = ["/api", "/t.js", "/v.js", "/r.js", "/h.js", "/replay-player.js"];

/**
 * Fetch fakes miss iframe requests, such as the replay player.
 * Return 404 in tests to avoid reaching a local API or serving the dashboard.
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
    // The entry is about 510 kB. INITIAL_JS_BUDGET limits the full initial load;
    // this warning catches chunks well above the entry's size.
    chunkSizeWarningLimit: 600,
  },
  server: {
    // Keep API paths on the same origin in development; tests use noApiInTests.
    proxy: process.env.VITEST ? {} : Object.fromEntries(API_PATHS.map((path) => [path, apiOrigin])),
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/*.test.ts"], environment: "node" },
      },
      {
        // Uses tests/browser/fake-api.ts. Install Chromium once per machine:
        // pnpm exec playwright install --only-shell chromium
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
               * Tests start dark (tests/browser/setup.ts) and may switch to light.
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
