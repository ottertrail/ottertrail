import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { applyTelemetryRetention, ttlDays } from "../src/clickhouse/migrate.ts";
import { FORCE_MERGE_SECONDS, TELEMETRY_TABLES } from "../src/clickhouse/migrations.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";

let clickhouse: TestClickHouse;

beforeAll(async () => {
  clickhouse = await createTestClickHouse();
});

afterAll(async () => {
  await clickhouse?.destroy();
});

/** Each telemetry table's TTL, in days, as ClickHouse has it. */
async function retention(): Promise<Record<string, number | null>> {
  const result = await clickhouse.client.query({
    query: `SELECT name, engine_full FROM system.tables
            WHERE database = {database:String} AND name IN {tables:Array(String)} ORDER BY name`,
    query_params: { database: clickhouse.database, tables: [...TELEMETRY_TABLES] },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ name: string; engine_full: string }>();
  return Object.fromEntries(rows.map((row) => [row.name, ttlDays(row.engine_full)]));
}

const EVERY_TABLE = TELEMETRY_TABLES.toSorted();

describe("telemetry retention (TELEMETRY_RETENTION_DAYS)", () => {
  test("the tables start at 30 days, by whole days", async () => {
    expect(await retention()).toEqual(Object.fromEntries(EVERY_TABLE.map((name) => [name, 30])));
    const [table] = await (
      await clickhouse.client.query({
        query: `SELECT engine_full FROM system.tables
                WHERE database = {database:String} AND name = 'logs'`,
        query_params: { database: clickhouse.database },
        format: "JSONEachRow",
      })
    ).json<{ engine_full: string }>();
    expect(table?.engine_full).toContain("ttl_only_drop_parts = 1");
    expect(table?.engine_full).toContain("PARTITION BY toDate(timestamp)");
    expect(table?.engine_full).toContain("ORDER BY (project_id, timestamp, id)");
  });

  test("every table forces a day's parts into one once they are an hour old (0002)", async () => {
    const result = await clickhouse.client.query({
      query: `SELECT name, engine_full FROM system.tables
              WHERE database = {database:String} AND name IN {tables:Array(String)} ORDER BY name`,
      query_params: { database: clickhouse.database, tables: [...TELEMETRY_TABLES] },
      format: "JSONEachRow",
    });
    const tables = await result.json<{ name: string; engine_full: string }>();
    expect(tables.map((table) => table.name)).toEqual(EVERY_TABLE);
    for (const table of tables) {
      expect(table.engine_full).toContain(
        `min_age_to_force_merge_seconds = ${FORCE_MERGE_SECONDS}`,
      );
      expect(table.engine_full).toContain("min_age_to_force_merge_on_partition_only = 1");
      // Still what applyTelemetryRetention reads.
      expect(ttlDays(table.engine_full)).not.toBeNull();
    }
  });

  test("a new retention changes every table once; the same again changes nothing", async () => {
    expect(await applyTelemetryRetention(clickhouse.client, clickhouse.database, 30)).toEqual([]);

    expect(await applyTelemetryRetention(clickhouse.client, clickhouse.database, 90)).toEqual(
      EVERY_TABLE,
    );
    expect(await retention()).toEqual(Object.fromEntries(EVERY_TABLE.map((name) => [name, 90])));
    expect(await applyTelemetryRetention(clickhouse.client, clickhouse.database, 90)).toEqual([]);

    expect(await applyTelemetryRetention(clickhouse.client, clickhouse.database, 7)).toEqual(
      EVERY_TABLE,
    );
    expect(await retention()).toEqual(Object.fromEntries(EVERY_TABLE.map((name) => [name, 7])));
  });

  test("refuses a retention outside 1 to 365 days", async () => {
    await expect(
      applyTelemetryRetention(clickhouse.client, clickhouse.database, 0),
    ).rejects.toThrow(RangeError);
    await expect(
      applyTelemetryRetention(clickhouse.client, clickhouse.database, 366),
    ).rejects.toThrow(RangeError);
  });

  test("reads the days from a table's definition", () => {
    expect(
      ttlDays(
        "ReplacingMergeTree PARTITION BY toDate(timestamp) ORDER BY (project_id, timestamp, id) TTL toDateTime(timestamp) + toIntervalDay(14) SETTINGS ttl_only_drop_parts = 1",
      ),
    ).toBe(14);
    expect(ttlDays("MergeTree ORDER BY name")).toBeNull();
  });
});

describe("forced merges", () => {
  test("a day with a retried copy is merged once its parts pass the age, without OPTIMIZE", async () => {
    // Two tables of the spans table's definition: one with its age cut to
    // 1 second, so the test need not wait an hour (the setting, not its
    // value, is under test), and one without forced merges, for comparison.
    const suffix = randomUUID().replaceAll("-", "");
    const forced = `spans_forced_${suffix}`;
    const plain = `spans_plain_${suffix}`;
    for (const table of [forced, plain]) {
      await clickhouse.client.command({ query: `CREATE TABLE ${table} AS spans` });
    }
    await clickhouse.client.command({
      query: `ALTER TABLE ${forced} MODIFY SETTING min_age_to_force_merge_seconds = 1`,
    });
    await clickhouse.client.command({
      query: `ALTER TABLE ${plain} MODIFY SETTING min_age_to_force_merge_seconds = 0`,
    });
    const project = randomUUID();
    // Yesterday, from midnight UTC: the spans run 14 hours, all in one day. The tables copy the spans
    // table, which the test above left at 7 days, so a fixed date would lose rows to the TTL at
    // merge time once it was a week old.
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const insert = (table: string, rows: number) =>
      clickhouse.client.command({
        query: `INSERT INTO ${table} (project_id, timestamp, id, name, kind, service, environment)
                SELECT '${project}', toDateTime64('${day} 00:00:00', 9, 'UTC') + intDiv(number, 20),
                       toString(number), 'GET /', 'server', 'web', 'production'
                FROM numbers(${rows})`,
      });
    // A day of 1,000,000 spans, then a retry of 10 of them: two parts in one
    // day. ClickHouse's own merges leave a part this small beside one this
    // large: nothing makes them merge.
    for (const table of [forced, plain]) {
      await insert(table, 1_000_000);
      await insert(table, 10);
    }
    const state = async (table: string) => {
      const [row] = await (
        await clickhouse.client.query({
          query: `SELECT (SELECT count() FROM ${table}) AS rows,
                         (SELECT count() FROM system.parts
                          WHERE database = currentDatabase() AND table = {table:String} AND active) AS parts`,
          query_params: { table },
          format: "JSONEachRow",
        })
      ).json<{ rows: string; parts: string }>();
      return { rows: Number(row?.rows), parts: Number(row?.parts) };
    };
    // ClickHouse merges the forced table's day on its own once both parts
    // are a second old: the copy is gone, as FINAL would read it.
    await expect
      .poll(() => state(forced), { timeout: 60_000, interval: 500 })
      .toEqual({ rows: 1_000_000, parts: 1 });
    // The other table still counts the copy.
    expect(await state(plain)).toEqual({ rows: 1_000_010, parts: 2 });
    for (const table of [forced, plain]) {
      await clickhouse.client.command({ query: `DROP TABLE ${table}` });
    }
  }, 90_000);
});
