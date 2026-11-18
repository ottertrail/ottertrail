import type { ClickHouseSettings } from "@clickhouse/client";

import type { ClickHouseClient } from "./clickhouse.ts";

/**
 * Inserts rows into one table, the values as JSONEachRow, never in SQL
 * text. An asynchronous insert, waiting for the write: ClickHouse gathers
 * many small requests into one part, and this returns only once that part
 * is written, so a caller that answers after it confirms stored data.
 * Events and telemetry arrive in small requests, which as plain inserts
 * would each make a part of their own.
 */
export async function insertRows(
  clickhouse: ClickHouseClient,
  table: string,
  values: readonly object[],
  settings: ClickHouseSettings = {},
): Promise<void> {
  if (values.length === 0) return;
  await clickhouse.insert({
    table,
    values,
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1, ...settings },
  });
}
