import { defineConfig } from "vite-plus";

import { thirdPartyLicenses } from "../../scripts/third-party-licenses.ts";
import { REFERRER_SPAM_COMMIT } from "./src/enrichment/referrer-spam/list.ts";

export default defineConfig({
  pack: {
    // The commands an instance runs, bundled so a server needs only Node.js.
    entry: {
      server: "src/server.ts",
      worker: "src/worker.ts",
      migrate: "src/migrate.ts",
      setup: "scripts/setup.ts",
      "reset-password": "scripts/reset-password.ts",
      "update-geo": "scripts/update-geo.ts",
      "backup-objects": "scripts/backup-objects.ts",
      "restore-objects": "scripts/restore-objects.ts",
      "restore-backup": "scripts/restore-backup.ts",
    },
    platform: "node",
    // Dependencies go into the bundle, so a server needs only Node.js and
    // dist/. Installing them instead would bring optional peers of
    // better-auth (React, Vitest, Playwright) along: about 180 MB.
    deps: { alwaysBundle: [/./], onlyBundle: false },
    plugins: [
      thirdPartyLicenses({
        // OTLP's message definitions, kept in src/telemetry/proto/.
        vendored: [
          {
            name: "opentelemetry-proto",
            version: "1.11.1",
            license: "Apache-2.0",
            licenseFile: `${import.meta.dirname}/src/telemetry/proto/LICENSE`,
          },
          // Matomo's referrer spam list, as data (src/enrichment/referrer-spam/list.ts).
          {
            name: "matomo-referrer-spam-list",
            version: REFERRER_SPAM_COMMIT,
            license: "CC0-1.0",
            licenseFile: `${import.meta.dirname}/src/enrichment/referrer-spam/LICENSE`,
          },
        ],
      }),
    ],
    format: "esm",
    // For readable stack traces (node --enable-source-maps), which need only
    // the mappings: the maps leave the sources out, so the image carries no
    // copy of the TypeScript source or of the bundled packages' code.
    sourcemap: true,
    outputOptions: { sourcemapExcludeSources: true },
    dts: false,
  },
  test: {
    environment: "node",
    // Every test talks to real PostgreSQL and ClickHouse, and some build and
    // migrate a database of their own: run together, under load, a few take
    // longer than the default five seconds. Fifteen still catches a hang.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Drops the test schemas and databases runs that were cut off left behind.
    globalSetup: ["tests/helpers/global-setup.ts"],
  },
});
