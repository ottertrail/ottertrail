import type { ClickHouseSettings } from "@clickhouse/client";

import type { ClickHouseClient } from "./clickhouse.ts";

/**
 * Async inserts combine small requests into fewer parts. Wait for the write
 * before returning so callers acknowledge only stored data.
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
