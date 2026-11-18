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
  const result = await reader.client.query({
    query,
    query_params: params.values,
    format: "JSONEachRow",
    ...(settings === undefined ? {} : { clickhouse_settings: settings }),
    ...(reader.sessionId === undefined ? {} : { session_id: reader.sessionId }),
  });
  return result.json<Row>();
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
