import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { applyTelemetryRetention, ttlDays } from "../src/clickhouse/migrate.ts";
import { TELEMETRY_TABLES } from "../src/clickhouse/migrations.ts";
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
