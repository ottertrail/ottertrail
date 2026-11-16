import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { setUpLocation } from "./enrichment/setup.ts";

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl });
const location = await setUpLocation(config.geoSource, config.geoDatabasePath);
const app = buildApp({
  db,
  log: { level: config.logLevel },
  collection: { locate: location.locate, timeZone: config.timeZone },
  // A number means "trust this many proxy hops in front of the API".
  trustProxy:
    typeof config.trustProxy === "number"
      ? (
          (hops) => (_address: string, hop: number) =>
            hop < hops
        )(config.trustProxy)
      : config.trustProxy,
});
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
