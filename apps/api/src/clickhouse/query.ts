import type { ClickHouseSettings } from "@clickhouse/client";

import type { ClickHouseClient } from "./clickhouse.ts";

/**
 * Sessions share temporary tables (reports/analytics.ts).
 * ClickHouse allows only one query at a time per session.
 */
export interface Reader {
  client: ClickHouseClient;
  sessionId?: string | undefined;
  /**
   * Aborting closes the connection. ClickHouse stops the query only in
   * read-only mode (DASHBOARD_SETTINGS); otherwise its own limits apply.
   */
  signal?: AbortSignal | undefined;
  /** Runs each query, such as within a limit of queries at once (telemetry/dashboard-limit.ts). */
  gate?: (<T>(work: () => Promise<T>) => Promise<T>) | undefined;
  /** Deadline in milliseconds since 1970. Caps max_execution_time and refuses late starts. */
  deadline?: number | undefined;
  /** Per-query settings override these defaults (DASHBOARD_SETTINGS). */
  settings?: ClickHouseSettings | undefined;
}

/** A query refused because the reader's deadline had passed. */
export class DeadlineError extends Error {
  override name = "DeadlineError";
}

function withinDeadline(
  reader: Reader,
  settings: ClickHouseSettings | undefined,
): ClickHouseSettings | undefined {
  if (reader.deadline === undefined) return settings;
  const left = Math.floor((reader.deadline - Date.now()) / 1000);
  if (left < 1) throw new DeadlineError("The time limit expired before the query started.");
  const limit = settings?.max_execution_time ?? Number.POSITIVE_INFINITY;
  return { ...settings, max_execution_time: Math.min(limit, left) };
}

/** "2026-11-16 12:00:00.000": how ClickHouse writes and reads a DateTime64(3) in UTC. */
export function clickHouseTime(moment: Date): string {
  return moment.toISOString().replace("T", " ").replace("Z", "");
}

/** A DateTime64 as ClickHouse returns it (UTC), as a Date. */
export function fromClickHouseTime(text: string): Date {
  return new Date(`${text.replace(" ", "T")}Z`);
}

/** Keep external values in typed placeholders, outside SQL text. */
export class QueryParams {
  readonly values: Record<string, unknown> = {};
  #count = 0;

  /** A placeholder for `value` as ClickHouse type `type`, such as "String" or "UUID". */
  add(value: unknown, type: string): string {
    const name = `p${this.#count}`;
    this.#count += 1;
    this.values[name] = value;
    return `{${name}:${type}}`;
  }

  /** A placeholder for a moment, to compare with a DateTime64(3, 'UTC') column. */
  time(moment: Date): string {
    return this.add(clickHouseTime(moment), "DateTime64(3, 'UTC')");
  }
}

export async function queryRows<Row>(
  reader: Reader,
  query: string,
  params: QueryParams,
  /** ClickHouse settings for this query only, such as max_execution_time. */
  settings?: ClickHouseSettings,
): Promise<Row[]> {
  const run = async () => {
    const limited = withinDeadline(
      reader,
      reader.settings === undefined ? settings : { ...reader.settings, ...settings },
    );
    const result = await reader.client.query({
      query,
      query_params: params.values,
      format: "JSONEachRow",
      ...(limited === undefined ? {} : { clickhouse_settings: limited }),
      ...(reader.sessionId === undefined ? {} : { session_id: reader.sessionId }),
      ...(reader.signal === undefined ? {} : { abort_signal: reader.signal }),
    });
    // Keep the gate until all rows are read; the query is still running.
    return result.json<Row>();
  };
  return reader.gate === undefined ? run() : reader.gate(run);
}

export async function runCommand(
  reader: Reader,
  query: string,
  params: QueryParams = new QueryParams(),
): Promise<void> {
  await reader.client.command({
    query,
    query_params: params.values,
    ...(reader.sessionId === undefined ? {} : { session_id: reader.sessionId }),
  });
}
