/**
 * Force location updates regardless of the automatic-update setting (src/enrichment/updates.ts).
 * Write DB-IP data to GEO_DATABASE_PATH and provider ranges to DATA_CENTERS_PATH
 * (src/enrichment/data-center-sources.ts).
 * Validate files before replacing them; failed sources keep old data. The API reloads within 10
 * minutes. Use the worker lease and record status when PostgreSQL is reachable.
 */
import { resolve } from "node:path";

import { sql } from "kysely";

import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { manualUpdate, stopOnSignals } from "../src/enrichment/manual-update.ts";

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 2 });
let reachable = true;
try {
  await sql`select 1`.execute(db);
} catch (error) {
  reachable = false;
  console.warn(
    `PostgreSQL unreachable (${error instanceof Error ? error.message : String(error)}). Updating without a lease; this update won't appear in Settings.`,
  );
}

// Ctrl-C or a stop: the round ends early, gives back its lease, and deletes its partial file.
const controller = new AbortController();
const signals = stopOnSignals(controller);
const exitCode = await manualUpdate({
  db: reachable ? db : null,
  geoSource: config.geoSource,
  databasePath: resolve(config.geoDatabasePath),
  dataCentersPath: resolve(config.dataCentersPath),
  stop: controller.signal,
});
signals.remove();
await db.destroy();
process.exitCode = signals.exitCode() ?? exitCode;
