import { defineConfig } from "vite-plus";

import { thirdPartyLicenses } from "../../scripts/third-party-licenses.ts";

export default defineConfig({
  pack: {
    // The commands an instance runs, bundled so a server needs only Node.js.
    entry: {
      server: "src/server.ts",
      worker: "src/worker.ts",
      migrate: "src/migrate.ts",
      setup: "scripts/setup.ts",
      "update-geo": "scripts/update-geo.ts",
    },
    platform: "node",
    // Dependencies go into the bundle, so a server needs only Node.js and
    // dist/. Installing them instead would bring optional peers of
    // better-auth (React, Vitest, Playwright) along: about 180 MB.
    deps: { alwaysBundle: [/./], onlyBundle: false },
    plugins: [thirdPartyLicenses()],
    format: "esm",
    sourcemap: true,
    dts: false,
  },
  test: {
    environment: "node",
    // Every test talks to real PostgreSQL and ClickHouse, and some build and
    // migrate a database of their own: run together, under load, a few take
    // longer than the default five seconds. Fifteen still catches a hang.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
