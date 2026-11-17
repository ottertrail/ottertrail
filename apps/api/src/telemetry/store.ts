import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { TELEMETRY_TABLES } from "../clickhouse/migrations.ts";
import type { HistogramRow, LogRow, PointRow, SpanRow } from "./normalize.ts";

/** One request's rows, by table. */
export interface TelemetryRows {
  spans?: SpanRow[];
  logs?: LogRow[];
  metric_points?: PointRow[];
  metric_histograms?: HistogramRow[];
}

/**
 * Writes one request's rows: one insert per table, the values as
 * JSONEachRow, never in SQL text. Asynchronous inserts, waiting for the
 * write: ClickHouse gathers many small requests into one part, and this
 * returns only once that part is written, so the answer confirms the data.
 *
 * A request may hold records of many days, each its own partition: more
 * than ClickHouse's default 100 a block is a warning here, not an error,
 * as a retention of up to a year allows.
 */
export async function insertTelemetry(
  clickhouse: ClickHouseClient,
  rows: TelemetryRows,
): Promise<void> {
  const tables: [(typeof TELEMETRY_TABLES)[number], readonly object[] | undefined][] = [
    ["spans", rows.spans],
    ["logs", rows.logs],
    ["metric_points", rows.metric_points],
    ["metric_histograms", rows.metric_histograms],
  ];
  await Promise.all(
    tables.map(async ([table, values]) => {
      if (values === undefined || values.length === 0) return;
      await clickhouse.insert({
        table,
        values,
        format: "JSONEachRow",
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 1,
          throw_on_max_partitions_per_insert_block: 0,
        },
      });
    }),
  );
}
