import type { AiCallRow } from "../ai/calls.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { insertRows } from "../clickhouse/insert.ts";
import type { TELEMETRY_TABLES } from "../clickhouse/migrations.ts";
import { clickHouseTime } from "../clickhouse/query.ts";
import type { HistogramRow, LogRow, PointRow, SpanRow } from "./normalize.ts";

export interface TelemetryRows {
  spans?: SpanRow[];
  logs?: LogRow[];
  metric_points?: PointRow[];
  metric_histograms?: HistogramRow[];
  /** AI calls extracted from spans (ai/calls.ts), with the same retention as events. */
  ai_calls?: AiCallRow[];
}

/**
 * Waits for every table insert, including AI calls, before acknowledging the request
 * (clickhouse/insert.ts).
 *
 * Rows use the API's receivedAt (ClickHouse migration 0011), except logs, whose arrival uses
 * ClickHouse's clock (0005) for the live view (telemetry/logs.ts).
 *
 * Records span at most retention days plus two (normalize.ts). Disable ClickHouse's 100-partition
 * guard: up to a year of retention can exceed it, and async inserts combine requests across
 * projects into one block that would fail together.
 */
export async function insertTelemetry(
  clickhouse: ClickHouseClient,
  rows: TelemetryRows,
  { receivedAt = new Date() }: { receivedAt?: Date } = {},
): Promise<void> {
  const received = { received_at: clickHouseTime(receivedAt) };
  const arrived = (values: readonly object[] | undefined) =>
    values?.map((row) => ({ ...row, ...received }));
  const tables: [(typeof TELEMETRY_TABLES)[number] | "ai_calls", readonly object[] | undefined][] =
    [
      ["spans", arrived(rows.spans)],
      ["logs", rows.logs],
      ["metric_points", arrived(rows.metric_points)],
      ["metric_histograms", arrived(rows.metric_histograms)],
      ["ai_calls", arrived(rows.ai_calls)],
    ];
  await Promise.all(
    tables.map(async ([table, values]) =>
      insertRows(clickhouse, table, values ?? [], {
        throw_on_max_partitions_per_insert_block: 0,
      }),
    ),
  );
}
