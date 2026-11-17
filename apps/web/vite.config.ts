import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

import { thirdPartyLicenses } from "../../scripts/third-party-licenses.ts";

const apiOrigin = process.env.OTTERTRAIL_API_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: lazyPlugins(() => [
    react(),
    tailwindcss(),
    thirdPartyLicenses({
      stylesheets: [fileURLToPath(new URL("./src/styles/globals.css", import.meta.url))],
    }),
  ]),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // The API serves these on the instance's own origin; the dev server forwards them.
    proxy: {
      "/api": apiOrigin,
      "/t.js": apiOrigin,
    },
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
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
