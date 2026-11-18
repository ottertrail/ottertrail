/**
 * Command-line entry point: brings ClickHouse's and then PostgreSQL's
 * schema up to date. Run it as a deployment step before starting the API,
 * not from the API itself, so several API processes never race to migrate.
 *
 * ClickHouse first: an install whose events still arrived in PostgreSQL
 * has its events not yet copied to ClickHouse copied there before
 * PostgreSQL migration 0024 drops that table
 * (clickhouse/drain-postgres-events.ts). That table is first brought to
 * migration 0023's shape, which the copy reads. 0024 refuses while any
 * event is left (an API of the earlier version may still be adding them),
 * so this copies and tries again, a few times, then asks for the API and
 * the worker to be stopped.
 */
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import { drainPostgresEvents, needsEventDrain } from "./clickhouse/drain-postgres-events.ts";
import { applyTelemetryRetention, migrateClickHouse } from "./clickhouse/migrate.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { migrate, migrateToLatest } from "./db/migrate.ts";
import { UncopiedEventsError } from "./db/migrations/0024_drop_events.ts";

/** Copies, then tries to drop the table, this many times at most. */
const DRAIN_ATTEMPTS = 5;

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });
// Bound to "default", which always exists: migrating creates Ottertrail's database.
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
  report("ClickHouse", await migrateClickHouse(clickhouse, config.clickhouse.database));
  if (await needsEventDrain(db)) {
    report("PostgreSQL", await migrate(db, "0023_create_replays"));
    const events = createClickHouse(config.clickhouse);
    try {
      for (let attempt = 1; ; attempt += 1) {
        const copied = await drainPostgresEvents(db, events);
        console.log(`Copied ${copied} events from PostgreSQL to ClickHouse.`);
        try {
          report("PostgreSQL", await migrateToLatest(db));
          break;
        } catch (error) {
          const uncopied = error instanceof Error && error.cause instanceof UncopiedEventsError;
          if (!uncopied) throw error;
          if (attempt === DRAIN_ATTEMPTS) {
            throw new Error(
              "Events keep arriving in PostgreSQL from an API of the earlier version: stop the API and the worker (docker compose stop api worker), then run migrate again.",
              { cause: error },
            );
          }
        }
      }
    } finally {
      await events.close();
    }
  }
  report("PostgreSQL", await migrateToLatest(db));
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
