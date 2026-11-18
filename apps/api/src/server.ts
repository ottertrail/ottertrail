import { resolve } from "node:path";

import { buildApp } from "./app.ts";
import { createAuth } from "./auth/auth.ts";
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import { DEVELOPMENT_AUTH_SECRET, loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { setUpDataCenters, setUpLocation } from "./enrichment/setup.ts";
import { postgresKnowsTimeZone } from "./settings/settings.ts";
import { s3ObjectStore } from "./storage/object-store.ts";

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl });
// Events and telemetry are stored here, and reports read them (docs/clickhouse.md).
const clickhouse = createClickHouse(config.clickhouse);
// Source maps; none when the install has no object store (docs/errors.md).
const objectStore = config.objectStore === null ? null : s3ObjectStore(config.objectStore);
const auth = createAuth({
  db,
  publicUrl: config.publicUrl,
  trustedOrigins: config.trustedOrigins,
  secret: config.authSecret,
});
// The setup link sets the instance's timezone to TIMEZONE, and PostgreSQL
// counts its days: refuse to start with a name only Node.js knows.
if (!(await postgresKnowsTimeZone(db, config.defaultTimeZone))) {
  console.error(
    `TIMEZONE "${config.defaultTimeZone}" is not a timezone PostgreSQL knows. Choose another, such as "Europe/Berlin".`,
  );
  await db.destroy();
  await clickhouse.close();
  process.exit(1);
}
const location = await setUpLocation(config.geoSource, config.geoDatabasePath);
const dataCenters = await setUpDataCenters(config.dataCentersPath);
const app = buildApp({
  db,
  log: { level: config.logLevel },
  collection: {
    locate: location.locate,
    isDataCenter: dataCenters.isDataCenter,
    instanceLimit: {
      capacity: config.instanceEventsPerSecond * 10,
      refillPerSecond: config.instanceEventsPerSecond,
    },
  },
  dashboard: {
    auth,
    clickhouse,
    publicUrl: config.publicUrl,
    trustedOrigins: config.trustedOrigins,
    defaultTimeZone: config.defaultTimeZone,
  },
  objectStore,
  sourceMaps: { limitBytes: config.sourceMapStorageBytes },
  replays: { limitBytes: config.replayStorageBytes },
  telemetry: { retentionDays: config.telemetryRetentionDays },
  uptime: {
    allowPrivateAddresses: config.uptimeAllowPrivateAddresses,
    denyAddresses: config.uptimeDenyAddresses,
  },
  trackerScriptPath: config.trackerScriptPath,
  dashboardPath: resolve(config.dashboardPath),
  replayPlayerPath: resolve(config.replayPlayerPath),
  // A number means "trust this many proxy hops in front of the API".
  trustProxy:
    typeof config.trustProxy === "number"
      ? (
          (hops) => (_address: string, hop: number) =>
            hop < hops
        )(config.trustProxy)
      : config.trustProxy,
});
if (config.authSecret === DEVELOPMENT_AUTH_SECRET) {
  app.log.warn("AUTH_SECRET is not set: using the development secret, which is not secret");
}
if (objectStore === null) {
  app.log.info("OBJECT_STORE_URL is not set: source maps are off");
}
for (const setup of [location, dataCenters]) {
  if (setup.ok) {
    app.log.info(setup.message);
  } else {
    app.log.warn(setup.message);
  }
}

// Close database connections after the server stops accepting requests.
app.addHook("onClose", async () => {
  await db.destroy();
  await clickhouse.close();
  objectStore?.close();
});

async function shutdown(signal: NodeJS.Signals) {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
  } catch (error) {
    app.log.error(error, "error during shutdown");
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (received) => void shutdown(received));
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, "failed to start API server");
  process.exitCode = 1;
}
