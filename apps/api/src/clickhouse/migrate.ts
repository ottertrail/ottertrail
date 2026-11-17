import { type ClickHouseClient, identifier } from "./clickhouse.ts";
import { CLICKHOUSE_MIGRATIONS, type ClickHouseMigration } from "./migrations.ts";

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
