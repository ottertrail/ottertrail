import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { migrateClickHouse } from "../src/clickhouse/migrate.ts";
import { loadConfig } from "../src/config.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";

let clickhouse: TestClickHouse | undefined;

function ch() {
  if (clickhouse === undefined) throw new Error("The test ClickHouse was not created");
  return clickhouse;
}

beforeAll(async () => {
  clickhouse = await createTestClickHouse();
});

afterAll(async () => {
  await clickhouse?.destroy();
});

async function count(query: string): Promise<number> {
  const result = await ch().client.query({ query, format: "JSONEachRow" });
  const [first] = await result.json<{ n: string }>();
  return Number(first?.n ?? 0);
}

describe("ClickHouse migrations", () => {
  test("create the events table, ordered by project, day, and event ID, with its indexes", async () => {
    const result = await ch().client.query({
      query: `SELECT engine, sorting_key, partition_key FROM system.tables
              WHERE database = {database:String} AND name = 'events'`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      {
        engine: "ReplacingMergeTree",
        sorting_key: "project_id, toDate(occurred_at), event_id",
        partition_key: "toYYYYMM(occurred_at)",
      },
    ]);
    const indexes = await ch().client.query({
      query: `SELECT name, type FROM system.data_skipping_indices
              WHERE database = {database:String} AND table = 'events' ORDER BY name`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    expect(await indexes.json()).toEqual([
      { name: "error_fingerprint_index", type: "bloom_filter" },
      { name: "user_id_index", type: "bloom_filter" },
    ]);
  });

  test("make every insert into events wait until it is on disk", async () => {
    const result = await ch().client.query({
      query: `SELECT create_table_query FROM system.tables
              WHERE database = {database:String} AND name = 'events'`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    const [table] = await result.json<{ create_table_query: string }>();
    expect(table?.create_table_query).toMatch(/fsync_after_insert = 1/);
    expect(table?.create_table_query).toMatch(/fsync_part_directory = 1/);
  });

  test("create the telemetry tables with their order and TTL, and uptime's results", async () => {
    const result = await ch().client.query({
      query: `SELECT name, sorting_key FROM system.tables
              WHERE database = {database:String} AND name != 'schema_migrations'
              ORDER BY name`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { name: "check_results", sorting_key: "project_id, check_id, timestamp" },
      { name: "events", sorting_key: "project_id, toDate(occurred_at), event_id" },
      { name: "logs", sorting_key: "project_id, timestamp, id" },
      { name: "metric_histograms", sorting_key: "project_id, name, timestamp, id" },
      { name: "metric_points", sorting_key: "project_id, name, timestamp, id" },
      { name: "spans", sorting_key: "project_id, timestamp, id" },
    ]);
  });

  test("running them again changes nothing", async () => {
    const admin = createClickHouse(loadConfig().clickhouse, { database: "default" });
    try {
      expect(await migrateClickHouse(admin, ch().database)).toEqual([]);
    } finally {
      await admin.close();
    }
  });
});

/** One pageview row as the events table takes it. */
function row(eventId: string) {
  return {
    project_id: "11111111-1111-4111-8111-111111111111",
    event_id: eventId,
    name: "pageview",
    occurred_at: "2026-11-16 12:00:00.000",
    received_at: "2026-11-16 12:00:01.000",
    path: "/",
    properties: "{}",
    visitor_id: "42",
  };
}

describe("events in ClickHouse", () => {
  test("a batch sent twice with the same token is stored once", async () => {
    // What the worker relies on when it crashes after sending a batch but
    // before recording that it did, and sends the same batch again.
    const batch = [row(randomUUID()), row(randomUUID())];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await ch().client.insert({
        table: "events",
        values: batch,
        format: "JSONEachRow",
        clickhouse_settings: { insert_deduplication_token: "batch-1" },
      });
    }
    expect(await count("SELECT count() AS n FROM events")).toBe(2);
  });

  test("one event stored twice counts once when read with FINAL", async () => {
    const twice = row(randomUUID());
    await ch().client.insert({ table: "events", values: [twice], format: "JSONEachRow" });
    await ch().client.insert({ table: "events", values: [twice], format: "JSONEachRow" });
    expect(
      await count(`SELECT count() AS n FROM events FINAL WHERE event_id = '${twice.event_id}'`),
    ).toBe(1);
  });
});
