import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createClickHouse, identifier } from "../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { dropStaleTestDatabases, STALE_AFTER_MS } from "./helpers/stale-test-databases.ts";
import { dropTestSchema } from "./helpers/test-database.ts";
import { madeAt, testName } from "./helpers/test-names.ts";

/**
 * The test runs' own schemas and databases (helpers/test-names.ts): named
 * with when they were made, and dropped by a later run once a cut-off run
 * left them behind for more than two hours (helpers/global-setup.ts).
 */

const config = loadConfig();
const admin = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });
const clickhouse = createClickHouse(config.clickhouse, { database: "default" });
const now = Date.now();
const names = {
  old: testName(now - STALE_AFTER_MS - 60_000),
  recent: testName(now - STALE_AFTER_MS + 10 * 60_000),
  /** As older code names them: their age cannot be told, so they stay. */
  older: `test_${randomUUID().replaceAll("-", "")}`,
};

async function schemas(): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select nspname as name from pg_namespace where nspname = any(${Object.values(names)})
  `.execute(admin);
  return rows.map((row) => row.name).toSorted();
}

async function databases(): Promise<string[]> {
  const result = await clickhouse.query({
    query: "SELECT name FROM system.databases WHERE name IN {names:Array(String)} ORDER BY name",
    query_params: { names: Object.values(names) },
    format: "JSONEachRow",
  });
  return (await result.json<{ name: string }>()).map((row) => row.name);
}

beforeAll(async () => {
  for (const name of Object.values(names)) {
    await sql`create schema ${sql.id(name)}`.execute(admin);
    await clickhouse.command({ query: `CREATE DATABASE ${identifier(name)}` });
  }
});

afterAll(async () => {
  for (const name of Object.values(names)) {
    await dropTestSchema(name);
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${identifier(name)}` });
  }
  await admin.destroy();
  await clickhouse.close();
});

describe("test schema and database names", () => {
  test("hold when they were made, within a schema name's limit", () => {
    const name = testName(Date.UTC(2026, 10, 19, 12));
    expect(name).toMatch(/^test_1795089600_[0-9a-f]{16}$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(madeAt(name)).toEqual(new Date(Date.UTC(2026, 10, 19, 12)));
    expect(madeAt(names.older)).toBeNull();
    expect(madeAt("test_1795089600_xyz")).toBeNull();
  });
});

describe("a test run's start", () => {
  test("drops what a cut-off run left over two hours ago, and keeps the rest", async () => {
    const dropped = await dropStaleTestDatabases(now);
    expect(dropped.schemas).toContain(names.old);
    expect(dropped.databases).toContain(names.old);
    expect(dropped.schemas).not.toContain(names.recent);
    expect(await schemas()).toEqual([names.older, names.recent].toSorted());
    expect(await databases()).toEqual([names.older, names.recent].toSorted());
  });
});
