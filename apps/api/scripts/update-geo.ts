/**
 * Downloads what the API knows about IP addresses now, whatever is due and
 * whatever the instance's "Update location data automatically" setting
 * says. The worker does the same on its own while the setting is on
 * (src/enrichment/updates.ts, which this calls):
 *
 * 1. The latest DB-IP City Lite database (free, CC BY 4.0, updated
 *    monthly) to GEO_DATABASE_PATH, when GEO_SOURCE is "database". It is
 *    checked: it must open and answer a known lookup.
 * 2. The address ranges of cloud and hosting providers, to
 *    DATA_CENTERS_PATH (src/enrichment/data-center-sources.ts). A source
 *    that fails keeps its previous ranges.
 *
 * Each file replaces the old one in one step; if anything fails, the old
 * file stays. The API loads the new files within 10 minutes, without a
 * restart. With PostgreSQL reachable, the update takes the same lease as
 * the worker's and records its status for the Settings page.
 *
 *   vp run geo:update
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
    `PostgreSQL cannot be reached (${error instanceof Error ? error.message : String(error)}): updating without the lease, and the Settings page will not show this update.`,
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
