import type { AiCallRow } from "../ai/calls.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { insertRows } from "../clickhouse/insert.ts";
import type { TELEMETRY_TABLES } from "../clickhouse/migrations.ts";
import type { HistogramRow, LogRow, PointRow, SpanRow } from "./normalize.ts";

/** One request's rows, by table. */
export interface TelemetryRows {
  spans?: SpanRow[];
  logs?: LogRow[];
  metric_points?: PointRow[];
  metric_histograms?: HistogramRow[];
  /** The AI calls among the spans (ai/calls.ts): rows of their own table, kept as long as events. */
  ai_calls?: AiCallRow[];
}

/**
 * Writes one request's rows: one insert per table, each asynchronous and
 * waited for (clickhouse/insert.ts), so the answer confirms the data. A
 * traces request's AI calls go with its spans: the answer confirms both.
 *
 * A request may hold records of many days, each its own partition: more
 * than ClickHouse's default 100 a block is a warning here, not an error,
 * as a retention of up to a year allows.
 */
export async function insertTelemetry(
  clickhouse: ClickHouseClient,
  rows: TelemetryRows,
): Promise<void> {
  const tables: [(typeof TELEMETRY_TABLES)[number] | "ai_calls", readonly object[] | undefined][] =
    [
      ["spans", rows.spans],
      ["logs", rows.logs],
      ["metric_points", rows.metric_points],
      ["metric_histograms", rows.metric_histograms],
      ["ai_calls", rows.ai_calls],
    ];
  await Promise.all(
    tables.map(async ([table, values]) =>
      insertRows(clickhouse, table, values ?? [], {
        throw_on_max_partitions_per_insert_block: 0,
      }),
    ),
  );
}
