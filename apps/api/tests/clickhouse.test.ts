import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { migrateClickHouse } from "../src/clickhouse/migrate.ts";
import { CLICKHOUSE_MIGRATIONS, TELEMETRY_TABLES } from "../src/clickhouse/migrations.ts";
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
      // For a first-seen rebuild's events that arrived while it ran (0013).
      { name: "received_at_index", type: "minmax" },
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

  test("create the telemetry tables with their order and TTL, uptime's results, first-seen times, heatmaps, and AI calls", async () => {
    const result = await ch().client.query({
      query: `SELECT name, sorting_key FROM system.tables
              WHERE database = {database:String} AND name != 'schema_migrations'
              ORDER BY name`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      // By project, then day, as events; kept as long as them (0008, 0012).
      { name: "ai_calls", sorting_key: "project_id, toDate(timestamp), id" },
      { name: "check_results", sorting_key: "project_id, check_id, timestamp" },
      { name: "events", sorting_key: "project_id, toDate(occurred_at), event_id" },
      // By project, day, page, then device (0006).
      {
        name: "heatmaps",
        sorting_key: "project_id, toDate(occurred_at), path, device, kind, record_id",
      },
      { name: "logs", sorting_key: "project_id, timestamp, id" },
      { name: "metric_histograms", sorting_key: "project_id, name, timestamp, id" },
      { name: "metric_points", sorting_key: "project_id, name, timestamp, id" },
      { name: "spans", sorting_key: "project_id, timestamp, id" },
      { name: "user_first_seen", sorting_key: "project_id, environment, user_id" },
      // The materialized view that fills user_first_seen as events are stored.
      { name: "user_first_seen_mv", sorting_key: "" },
    ]);
  });

  test("create ai_calls by month, with no TTL, merged as the telemetry tables, written to disk as events", async () => {
    const result = await ch().client.query({
      query: `SELECT engine, partition_key, create_table_query FROM system.tables
              WHERE database = {database:String} AND name = 'ai_calls'`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    const [table] = await result.json<{
      engine: string;
      partition_key: string;
      create_table_query: string;
    }>();
    expect(table).toMatchObject({
      engine: "ReplacingMergeTree",
      partition_key: "toYYYYMM(timestamp)",
    });
    expect(table?.create_table_query).not.toMatch(/TTL/);
    expect(table?.create_table_query).toMatch(/min_age_to_force_merge_seconds = 3600/);
    expect(table?.create_table_query).toMatch(/min_age_to_force_merge_on_partition_only = 1/);
    expect(table?.create_table_query).toMatch(/fsync_after_insert = 1/);
    expect(table?.create_table_query).toMatch(/fsync_part_directory = 1/);
    const indexes = await ch().client.query({
      query: `SELECT name FROM system.data_skipping_indices
              WHERE database = {database:String} AND table = 'ai_calls'`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    expect(await indexes.json()).toEqual([{ name: "conversation_id_index" }]);
  });

  test("make every insert into traces, logs, and metrics wait until it is on disk (0010)", async () => {
    const result = await ch().client.query({
      query: `SELECT name, create_table_query FROM system.tables
              WHERE database = {database:String} AND name IN {tables:Array(String)} ORDER BY name`,
      query_params: { database: ch().database, tables: [...TELEMETRY_TABLES] },
      format: "JSONEachRow",
    });
    const tables = await result.json<{ name: string; create_table_query: string }>();
    expect(tables.map((table) => table.name)).toEqual(TELEMETRY_TABLES.toSorted());
    for (const table of tables) {
      expect(table.create_table_query).toMatch(/fsync_after_insert = 1/);
      expect(table.create_table_query).toMatch(/fsync_part_directory = 1/);
    }
  });

  test("give spans, metrics, and AI calls their arrival, with no default (0011)", async () => {
    const result = await ch().client.query({
      query: `SELECT table, type, default_kind FROM system.columns
              WHERE database = {database:String} AND name = 'received_at' ORDER BY table`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      { table: "ai_calls", type: "DateTime64(3, 'UTC')", default_kind: "" },
      { table: "events", type: "DateTime64(3, 'UTC')", default_kind: "" },
      { table: "heatmaps", type: "DateTime64(3, 'UTC')", default_kind: "" },
      // ClickHouse's clock as it writes the record, for the live view (0005).
      { table: "logs", type: "DateTime64(9, 'UTC')", default_kind: "DEFAULT" },
      { table: "metric_histograms", type: "DateTime64(3, 'UTC')", default_kind: "" },
      { table: "metric_points", type: "DateTime64(3, 'UTC')", default_kind: "" },
      { table: "spans", type: "DateTime64(3, 'UTC')", default_kind: "" },
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

describe("log records' arrival (migration 0005)", () => {
  test("a record written without one gets ClickHouse's time; the migration run again changes no arrival", async () => {
    const { client, database } = ch();
    const project = randomUUID();
    const record = (id: string, received?: string) => ({
      project_id: project,
      timestamp: "2026-11-16 12:00:00.000000000",
      observed_timestamp: "2026-11-16 12:00:01.000000000",
      id,
      body: id,
      ...(received === undefined ? {} : { received_at: received }),
    });
    await client.insert({
      table: "logs",
      values: [record("a".repeat(32)), record("b".repeat(32), "2026-11-16 12:00:05.000000000")],
      format: "JSONEachRow",
    });
    const arrivals = async () => {
      const result = await client.query({
        query: `SELECT id, toString(received_at) AS received FROM logs
                WHERE project_id = {project:UUID} ORDER BY id`,
        query_params: { project },
        format: "JSONEachRow",
      });
      return result.json<{ id: string; received: string }>();
    };
    const before = await arrivals();
    // The default: ClickHouse's clock as it wrote the record, not its time or observed time.
    expect(before[0]?.received.startsWith("2026-11-16")).toBe(false);
    expect(before[1]?.received).toBe("2026-11-16 12:00:05.000000000");

    const migration = CLICKHOUSE_MIGRATIONS.find((item) => item.name === "0005_log_received_at");
    for (const statement of migration?.statements(database) ?? []) {
      await client.command({ query: statement });
    }
    expect(await arrivals()).toEqual(before);
    const columns = await client.query({
      query: `SELECT default_expression FROM system.columns
              WHERE database = {database:String} AND table = 'logs' AND name = 'received_at'`,
      query_params: { database },
      format: "JSONEachRow",
    });
    expect(await columns.json()).toEqual([{ default_expression: "now64(9)" }]);
  });
});

describe("migration 0005 after a failure part way", () => {
  test("run again, it writes the observed time, not the rerun's, into records stored before it", async () => {
    const admin = createClickHouse(loadConfig().clickhouse, { database: "default" });
    const scratch = `${ch().database}_r5`;
    try {
      await migrateClickHouse(
        admin,
        scratch,
        CLICKHOUSE_MIGRATIONS.filter((migration) => migration.name < "0005"),
      );
      // A record stored before the migration: its part has no arrival column.
      await admin.insert({
        table: `${scratch}.logs`,
        values: [
          {
            project_id: randomUUID(),
            timestamp: "2026-11-16 12:00:00.000000000",
            observed_timestamp: "2026-11-16 12:00:01.000000000",
            id: "c".repeat(32),
            body: "stored before",
          },
        ],
        format: "JSONEachRow",
      });
      // A first run stopped with the column added and the default already now64, its
      // MATERIALIZE never finished: the part still has no column of its own.
      await admin.command({
        query: `ALTER TABLE ${scratch}.logs ADD COLUMN received_at DateTime64(9, 'UTC') DEFAULT observed_timestamp`,
      });
      await admin.command({
        query: `ALTER TABLE ${scratch}.logs MODIFY COLUMN received_at DEFAULT now64(9)`,
      });
      const migration = CLICKHOUSE_MIGRATIONS.find((item) => item.name === "0005_log_received_at");
      for (const statement of migration?.statements(scratch) ?? []) {
        await admin.command({ query: statement });
      }
      const result = await admin.query({
        query: `SELECT toString(received_at) AS received FROM ${scratch}.logs`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([{ received: "2026-11-16 12:00:01.000000000" }]);
    } finally {
      await admin.command({ query: `DROP DATABASE IF EXISTS ${scratch}` });
      await admin.close();
    }
  });
});

describe("ai_calls keyed by day (migration 0012)", () => {
  test("on a database with 0008 and 0009, copies every call, and a rerun after a failure copies them again", async () => {
    const admin = createClickHouse(loadConfig().clickhouse, { database: "default" });
    const scratch = `${ch().database}_r12`;
    const project = randomUUID();
    const call = (id: string, overrides: Record<string, unknown> = {}) => ({
      project_id: project,
      timestamp: "2026-11-16 12:00:00.000000000",
      id,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      conversation_id: `conversation-${id}`,
      input_tokens: 1000,
      cache_read_tokens: 500,
      ...overrides,
    });
    const rows = async () => {
      const result = await admin.query({
        query: `SELECT id, conversation_id, input_includes_cache, toString(received_at) AS received
                FROM ${scratch}.ai_calls FINAL ORDER BY id`,
        format: "JSONEachRow",
      });
      return result.json();
    };
    try {
      await migrateClickHouse(
        admin,
        scratch,
        CLICKHOUSE_MIGRATIONS.filter((migration) => migration.name < "0010"),
      );
      await admin.insert({
        table: `${scratch}.ai_calls`,
        // Counted apart (less input than cached), and in.
        values: [call("a", { input_tokens: 10 }), call("b")],
        format: "JSONEachRow",
      });
      await migrateClickHouse(admin, scratch);
      const copied = [
        {
          id: "a",
          conversation_id: "conversation-a",
          input_includes_cache: false,
          received: "1970-01-01 00:00:00.000",
        },
        {
          id: "b",
          conversation_id: "conversation-b",
          input_includes_cache: true,
          received: "1970-01-01 00:00:00.000",
        },
      ];
      expect(await rows()).toEqual(copied);
      const keys = await admin.query({
        query: `SELECT name, sorting_key FROM system.tables
                WHERE database = {database:String} AND name LIKE 'ai_calls%'`,
        query_params: { database: scratch },
        format: "JSONEachRow",
      });
      expect(await keys.json()).toEqual([
        { name: "ai_calls", sorting_key: "project_id, toDate(timestamp), id" },
      ]);

      // A run stopped after the exchange, the old table not dropped: run again, it ends the same.
      await admin.command({
        query: `CREATE TABLE ${scratch}.ai_calls_by_day AS ${scratch}.ai_calls`,
      });
      const migration = CLICKHOUSE_MIGRATIONS.find((item) => item.name === "0012_ai_calls_by_day");
      for (const statement of migration?.statements(scratch) ?? []) {
        await admin.command({ query: statement });
      }
      expect(await rows()).toEqual(copied);

      // A retry with a corrected time on the same day is one row under FINAL.
      await admin.insert({
        table: `${scratch}.ai_calls`,
        values: [call("b", { timestamp: "2026-11-16 12:00:03.000000000" })],
        format: "JSONEachRow",
      });
      expect(await rows()).toHaveLength(2);
    } finally {
      await admin.command({ query: `DROP DATABASE IF EXISTS ${scratch}` });
      await admin.close();
    }
  });
});

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
