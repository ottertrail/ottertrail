import { sql } from "kysely";

import { createClickHouse, identifier } from "../../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../../src/config.ts";
import { createDatabase } from "../../src/db/database.ts";
import { dropTestSchema } from "./test-database.ts";
import { madeAt } from "./test-names.ts";

/** No test file runs this long, so older databases can be cleaned up. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function isStale(name: string, now: number): boolean {
  const made = madeAt(name);
  return made !== null && now - made.getTime() > STALE_AFTER_MS;
}

/**
 * Clean up interrupted runs. Leftover schemas slow Kysely's all-schema listing.
 *
 * Leave names without a known timestamp alone, including "test_<32 hex digits>",
 * to protect concurrent runs using that format.
 */
export async function dropStaleTestDatabases(
  now: number = Date.now(),
): Promise<{ schemas: string[]; databases: string[] }> {
  const config = loadConfig();

  const admin = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });
  let schemas: string[];
  try {
    const { rows } = await sql<{ name: string }>`
      select nspname as name from pg_namespace where nspname like 'test\\_%'
    `.execute(admin);
    schemas = rows.map((row) => row.name).filter((name) => isStale(name, now));
  } finally {
    await admin.destroy();
  }
  for (const schema of schemas) await dropTestSchema(schema);

  const clickhouse = createClickHouse(config.clickhouse, { database: "default" });
  let databases: string[];
  try {
    const result = await clickhouse.query({
      query: "SELECT name FROM system.databases WHERE startsWith(name, 'test_')",
      format: "JSONEachRow",
    });
    databases = (await result.json<{ name: string }>())
      .map((row) => row.name)
      .filter((name) => isStale(name, now));
    for (const database of databases) {
      await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${identifier(database)}` });
    }
  } finally {
    await clickhouse.close();
  }
  return { schemas, databases };
}
