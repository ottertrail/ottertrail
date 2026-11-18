import type { ClickHouseSettings } from "@clickhouse/client";

import type { ClickHouseClient } from "./clickhouse.ts";

/**
 * Where report queries run. With a session, they can read the temporary
 * tables an earlier query of the same session made (reports/analytics.ts).
 * Queries in one session run one after another: ClickHouse refuses two at once.
 */
export interface Reader {
  client: ClickHouseClient;
  sessionId?: string | undefined;
  /**
   * Closes the query's connection when it fires, such as when the browser
   * gives up on the request. ClickHouse then stops the query only if it
   * runs read-only (DASHBOARD_SETTINGS' readonly); otherwise it runs on to
   * its own limits.
   */
  signal?: AbortSignal | undefined;
  /** Runs each query, such as within a limit of queries at once (telemetry/dashboard-limit.ts). */
  gate?: (<T>(work: () => Promise<T>) => Promise<T>) | undefined;
  /**
   * When the reader's work must be over (milliseconds since 1970), such as
   * an alert rule's budget: each query's max_execution_time is cut to the
   * time left, and a query that would start past it is refused.
   */
  deadline?: number | undefined;
}

/** A query refused because the reader's deadline had passed. */
export class DeadlineError extends Error {
  override name = "DeadlineError";
}

/** The settings with max_execution_time cut to what is left before the reader's deadline. */
function withinDeadline(
  reader: Reader,
  settings: ClickHouseSettings | undefined,
): ClickHouseSettings | undefined {
  if (reader.deadline === undefined) return settings;
  const left = Math.floor((reader.deadline - Date.now()) / 1000);
  if (left < 1) throw new DeadlineError("The time for this work ran out before the query.");
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

/**
 * The values of one query, each behind a typed placeholder. Every value from
 * outside, such as a filter or a search, goes in through here, never into the
 * SQL text.
 */
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

/** Runs a query and returns its rows. */
export async function queryRows<Row>(
  reader: Reader,
  query: string,
  params: QueryParams,
  /** ClickHouse settings for this query only, such as max_execution_time. */
  settings?: ClickHouseSettings,
): Promise<Row[]> {
  const run = async () => {
    const limited = withinDeadline(reader, settings);
    const result = await reader.client.query({
      query,
      query_params: params.values,
      format: "JSONEachRow",
      ...(limited === undefined ? {} : { clickhouse_settings: limited }),
      ...(reader.sessionId === undefined ? {} : { session_id: reader.sessionId }),
      ...(reader.signal === undefined ? {} : { abort_signal: reader.signal }),
    });
    // Read whole within the gate: the query runs until its rows are read.
    return result.json<Row>();
  };
  return reader.gate === undefined ? run() : reader.gate(run);
}

/** Runs a statement that returns nothing, such as CREATE TEMPORARY TABLE. */
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
