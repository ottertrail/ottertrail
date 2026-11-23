import { resolve } from "node:path";

import { buildApp } from "./app.ts";
import { createAuth } from "./auth/auth.ts";
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import { DEVELOPMENT_AUTH_SECRET, loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { LiveLocationData } from "./enrichment/reload.ts";
import { smtpMailer } from "./notifications/email.ts";
import { ServerLogBuffer } from "./server-log/buffer.ts";
import { WorkerLogListener } from "./server-log/listener.ts";
import { s3ObjectStore } from "./storage/object-store.ts";
import { storageSourcesOf } from "./storage/usage.ts";

const config = loadConfig();
// The Settings page's Server log: this process's lines and the worker's, in memory only.
const serverLogBuffer = new ServerLogBuffer();
const db = createDatabase({
  connectionString: config.databaseUrl,
  // Only after startup, when `app` exists: an idle connection ending.
  onIdleError: (error) =>
    app.log.warn(
      { err: error.message },
      "an idle PostgreSQL connection ended; the next query opens a new one",
    ),
});
// Events and telemetry are stored here, and reports read them (docs/clickhouse.md).
const clickhouse = createClickHouse(config.clickhouse);
// Source maps; none when the install has no object store (docs/errors.md).
const objectStore = config.objectStore === null ? null : s3ObjectStore(config.objectStore);
// The test email on the Notification channels tab goes out from the API;
// account email is queued for the worker, which has its own mailer.
const mailer = config.email === null ? null : smtpMailer(config.email);
const auth = createAuth({
  db,
  publicUrl: config.publicUrl,
  trustedOrigins: config.trustedOrigins,
  secret: config.authSecret,
});
// Reloaded when the worker or the manual command replaces a file (enrichment/reload.ts).
const { data: locationData, messages: locationMessages } = await LiveLocationData.open({
  geoSource: config.geoSource,
  databasePath: config.geoDatabasePath,
  dataCentersPath: config.dataCentersPath,
});
const app = buildApp({
  db,
  log: { level: config.logLevel },
  serverLog: { buffer: serverLogBuffer },
  collection: {
    locate: locationData.locate,
    isDataCenter: locationData.isDataCenter,
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
  },
  objectStore,
  locationData,
  sourceMaps: { limitBytes: config.sourceMapStorageBytes },
  replays: { limitBytes: config.replayStorageBytes },
  telemetry: { retentionDays: config.telemetryRetentionDays },
  uptime: {
    allowPrivateAddresses: config.uptimeAllowPrivateAddresses,
    denyAddresses: config.uptimeDenyAddresses,
  },
  // SMTP_URL holds a password: it goes only to the mailer, never logged.
  notifications: { emailConfigured: config.email !== null, mailer, linkSecret: config.authSecret },
  // Garage's admin token goes only to its client: never logged or returned.
  storage: storageSourcesOf(config, db, clickhouse),
  // The backup key is sealed with AUTH_SECRET; where backups go is the worker's alone.
  backups: { authSecret: config.authSecret },
  trackerScriptPath: config.trackerScriptPath,
  dashboardPath: resolve(config.dashboardPath),
  replayPlayerPath: resolve(config.replayPlayerPath),
  // After the server stops accepting requests and the last ingestion counts
  // are written: never an onClose hook of its own, which would run first.
  closeAfter: async () => {
    locationData.stop();
    await workerLog.stop();
    await db.destroy();
    await clickhouse.close();
    objectStore?.close();
    mailer?.close();
  },
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
for (const setup of locationMessages) {
  if (setup.ok) {
    app.log.info(setup.message);
  } else {
    app.log.warn(setup.message);
  }
}
locationData.start({
  info: (msg) => app.log.info(msg),
  warn: (msg) => app.log.warn(msg),
});
// The worker's lines, over PostgreSQL's NOTIFY (server-log/relay.ts), on a connection of their own.
const workerLog = new WorkerLogListener({
  connectionString: config.databaseUrl,
  buffer: serverLogBuffer,
  log: app.log,
});
workerLog.start();

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
