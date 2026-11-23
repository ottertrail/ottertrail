/** Run before starting the API to avoid concurrent schema migrations. */
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import { applyTelemetryRetention, migrateClickHouse } from "./clickhouse/migrate.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { migrateToLatest } from "./db/migrate.ts";

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });
// Use "default" because Ottertrail's database may not exist yet.
const clickhouse = createClickHouse(config.clickhouse, { database: "default" });

function report(store: string, results: { status: string; migrationName: string }[]) {
  if (results.length === 0) {
    console.log(`${store} is up to date; no migrations to run.`);
  }
  for (const result of results) {
    console.log(
      `${store} ${result.status === "Success" ? "applied" : result.status}: ${result.migrationName}`,
    );
  }
}

try {
  report("PostgreSQL", await migrateToLatest(db));
  report("ClickHouse", await migrateClickHouse(clickhouse, config.clickhouse.database));
  const retained = await applyTelemetryRetention(
    clickhouse,
    config.clickhouse.database,
    config.telemetryRetentionDays,
  );
  if (retained.length > 0) {
    console.log(
      `ClickHouse keeps telemetry ${config.telemetryRetentionDays} days now: ${retained.join(", ")}`,
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
  await clickhouse.close();
}
