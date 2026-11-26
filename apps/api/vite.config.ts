import { defineConfig } from "vite-plus";

import { thirdPartyLicenses } from "../../scripts/third-party-licenses.ts";
import { REFERRER_SPAM_COMMIT } from "./src/enrichment/referrer-spam/list.ts";

// GitHub's runner for a private repository has 2 CPUs, against 14 threads
// locally: in CI (CI=true) tests and waits get longer limits.
const CI = process.env.CI === "true";

export default defineConfig({
  pack: {
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
    // Tells a built API from one run from source (src/version.ts).
    define: { OTTERTRAIL_BUNDLED: "true" },
    // Bundling avoids installing about 180 MB of better-auth optional peers.
    deps: { alwaysBundle: [/./], onlyBundle: false },
    plugins: [
      thirdPartyLicenses({
        vendored: [
          {
            name: "opentelemetry-proto",
            version: "1.11.1",
            license: "Apache-2.0",
            licenseFile: `${import.meta.dirname}/src/telemetry/proto/LICENSE`,
          },
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
    // Stack traces need mappings, but the image does not need embedded source code.
    sourcemap: true,
    outputOptions: { sourcemapExcludeSources: true },
    dts: false,
  },
  test: {
    environment: "node",
    // Database setup under concurrent load can exceed the default five seconds.
    testTimeout: CI ? 60_000 : 15_000,
    hookTimeout: CI ? 120_000 : 30_000,
    // With a 7-CPU, 4 GB database VM, 5 workers matched 13 in total time
    // (170 s vs. 178 s) and cut the slowest setup from 8 s to 4.5 s.
    maxWorkers: 5,
    // Clean up schemas and databases left by interrupted runs.
    globalSetup: ["tests/helpers/global-setup.ts"],
  },
});
