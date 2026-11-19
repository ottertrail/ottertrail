/**
 * Fills the development instance with demo data: a project named "Demo
 * shop" whose every dashboard page has something to show (seed-data.ts).
 *
 *   vp run seed
 *   vp run seed -- --yes     (when the settings do not look like development)
 *
 * For development only. Running it again replaces the project; deleting
 * the project removes its data. It refuses to run with NODE_ENV=production,
 * and asks for --yes when any setting points away from the local
 * development stack.
 */
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";
import { DEMO_CHANNEL_NAME, DEMO_PROJECT_NAME, seedDemo } from "./seed-data.ts";
import { refusalOf } from "./seed-safety.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const unknown = args.filter((arg) => arg !== "--yes");
if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(" ")}\nUsage: vp run seed [-- --yes]`);
  process.exit(1);
}

const config = loadConfig();
const refusal = refusalOf(process.env, config, { yes: args.includes("--yes") });
if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}

const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 4 });
const clickhouse = createClickHouse(config.clickhouse);
const store = config.objectStore === null ? null : s3ObjectStore(config.objectStore);
const started = performance.now();
try {
  console.log(`Making the "${DEMO_PROJECT_NAME}" project …`);
  if (store === null)
    console.log("No object store is set up: source maps and session replays are left out.");
  const result = await seedDemo({
    db,
    clickhouse,
    store,
    publicUrl: config.publicUrl,
    telemetryRetentionDays: config.telemetryRetentionDays,
    sourceMapLimitBytes: config.sourceMapStorageBytes,
    replayLimitBytes: config.replayStorageBytes,
    log: (message) => console.log(`  ${message}`),
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const { counts } = result;
  console.log(
    [
      "",
      `Done in ${seconds} s. "${DEMO_PROJECT_NAME}" (${result.projectId}) has:`,
      `  ${counts.events.toLocaleString("en")} events (${counts.serverErrors} of them server exceptions), from ${counts.knownUsers} signed-in users and anonymous visitors`,
      `  ${counts.spans.toLocaleString("en")} spans, ${counts.logs.toLocaleString("en")} log records, ${counts.metricPoints.toLocaleString("en")} metric points`,
      `  ${counts.replays} session replays, ${counts.sourceMaps} source maps`,
      `  ${counts.heatmapRecords.toLocaleString("en")} heatmap clicks and scroll depths`,
      `  ${counts.checks} uptime checks with ${counts.checkResults.toLocaleString("en")} results and ${counts.incidents} incidents`,
      `  ${counts.rules} alert rules, ${counts.alerts} alerts in their history, ${counts.firing} firing now`,
      "",
      `Its alerts go to the "${DEMO_CHANNEL_NAME}" channel, which reaches no one.`,
      "Run the command again to make it afresh; delete the project in its settings to remove it.",
    ].join("\n"),
  );
} finally {
  store?.close();
  await clickhouse.close();
  await db.destroy();
}
