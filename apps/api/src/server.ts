import { resolve } from "node:path";

import { buildApp } from "./app.ts";
import { createAuth } from "./auth/auth.ts";
import { DEVELOPMENT_AUTH_SECRET, loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { setUpLocation } from "./enrichment/setup.ts";

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl });
const auth = createAuth({
  db,
  publicUrl: config.publicUrl,
  trustedOrigins: config.trustedOrigins,
  secret: config.authSecret,
});
const location = await setUpLocation(config.geoSource, config.geoDatabasePath);
const app = buildApp({
  db,
  log: { level: config.logLevel },
  collection: { locate: location.locate, timeZone: config.timeZone },
  dashboard: {
    auth,
    publicUrl: config.publicUrl,
    trustedOrigins: config.trustedOrigins,
    timeZone: config.timeZone,
  },
  trackerScriptPath: config.trackerScriptPath,
  dashboardPath: resolve(config.dashboardPath),
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
if (location.ok) {
  app.log.info(location.message);
} else {
  app.log.warn(location.message);
}

// Close database connections after the server stops accepting requests.
app.addHook("onClose", async () => {
  await db.destroy();
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
