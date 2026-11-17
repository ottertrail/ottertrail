import { type ClickHouseClient, createClient } from "@clickhouse/client";

import type { ClickHouseConfig } from "../config.ts";

export type { ClickHouseClient };

/**
 * A ClickHouse client for one database. Queries name their tables without
 * a database, so tests can point the same code at a database of their own.
 */
export function createClickHouse(
  config: ClickHouseConfig,
  { database = config.database }: { database?: string } = {},
): ClickHouseClient {
  return createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    database,
    application: "ottertrail",
    // Report queries can sort a long range of events; the server's own
    // limits (deploy/clickhouse/) decide how far they may go. Progress
    // headers keep a long query's connection from looking idle.
    request_timeout: 120_000,
    clickhouse_settings: {
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: "10000",
      // 64-bit integers (visitor IDs, counts) as strings in JSON: a JavaScript
      // number would round them. ClickHouse 26 sends them bare by default.
      output_format_json_quote_64bit_integers: 1,
    },
  });
}

/** A ClickHouse identifier, quoted. Only ever used for names Ottertrail makes. */
export function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Not a safe ClickHouse identifier: ${name}`);
  }
  return `\`${name}\``;
}
