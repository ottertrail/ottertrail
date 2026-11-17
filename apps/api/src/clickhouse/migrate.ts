import { type ClickHouseClient, identifier } from "./clickhouse.ts";
import { CLICKHOUSE_MIGRATIONS, type ClickHouseMigration, TELEMETRY_TABLES } from "./migrations.ts";

export interface ClickHouseMigrationResult {
  migrationName: string;
  status: "Success";
}

/**
 * Creates the database if needed and applies the migrations that have not
 * run in it yet, in order. Safe to repeat. `client` may be bound to any
 * database that exists ("default" always does); tables are named with
 * `database` in front.
 *
 * ClickHouse has no transactions across statements: a migration that fails
 * halfway stays half applied and is not recorded, so its next run must be
 * able to start over. CREATE ... IF NOT EXISTS keeps that simple. Run it as
 * one deployment step, never from two processes at once.
 */
export async function migrateClickHouse(
  client: ClickHouseClient,
  database: string,
  migrations: readonly ClickHouseMigration[] = CLICKHOUSE_MIGRATIONS,
): Promise<ClickHouseMigrationResult[]> {
  const db = identifier(database);
  await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${db}` });
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS ${db}.schema_migrations (
      name String,
      applied_at DateTime DEFAULT now()
    ) ENGINE = MergeTree ORDER BY name`,
  });
  const applied = await client.query({
    query: `SELECT name FROM ${db}.schema_migrations`,
    format: "JSONEachRow",
  });
  const done = new Set((await applied.json<{ name: string }>()).map((row) => row.name));

  const results: ClickHouseMigrationResult[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    for (const statement of migration.statements(db)) {
      await client.command({ query: statement });
    }
    await client.insert({
      table: `${db}.schema_migrations`,
      values: [{ name: migration.name }],
      format: "JSONEachRow",
    });
    results.push({ migrationName: migration.name, status: "Success" });
  }
  return results;
}

/** The days a telemetry table's TTL keeps, as ClickHouse writes it back; null without one. */
export function ttlDays(engineFull: string): number | null {
  const match = /\bTTL toDateTime\(timestamp\) \+ toIntervalDay\((\d+)\)/.exec(engineFull);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Sets how many days ClickHouse keeps traces, logs, and metrics
 * (TELEMETRY_RETENTION_DAYS), and returns the tables it changed. A table
 * already at `days` is left alone, so running it again changes nothing.
 * ClickHouse then works out again, in the background, which whole days it
 * may drop. Run it after migrateClickHouse(), which creates the tables.
 */
export async function applyTelemetryRetention(
  client: ClickHouseClient,
  database: string,
  days: number,
): Promise<string[]> {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new RangeError(`telemetry retention must be 1 to 365 days, received ${days}`);
  }
  const db = identifier(database);
  const result = await client.query({
    query: `SELECT name, engine_full FROM system.tables
            WHERE database = {database:String} AND name IN {tables:Array(String)}`,
    query_params: { database, tables: [...TELEMETRY_TABLES] },
    format: "JSONEachRow",
  });
  const tables = await result.json<{ name: string; engine_full: string }>();
  const changed: string[] = [];
  for (const table of tables) {
    if (ttlDays(table.engine_full) === days) continue;
    await client.command({
      query: `ALTER TABLE ${db}.${identifier(table.name)}
              MODIFY TTL toDateTime(timestamp) + INTERVAL ${days} DAY`,
    });
    changed.push(table.name);
  }
  return changed.toSorted();
}
