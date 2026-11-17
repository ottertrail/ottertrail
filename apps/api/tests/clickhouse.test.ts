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
  test("create the events table, ordered by project and time", async () => {
    const result = await ch().client.query({
      query: `SELECT engine, sorting_key, partition_key FROM system.tables
              WHERE database = {database:String} AND name = 'events'`,
      query_params: { database: ch().database },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([
      {
        engine: "ReplacingMergeTree",
        sorting_key: "project_id, occurred_at, event_id",
        partition_key: "toYYYYMM(occurred_at)",
      },
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
