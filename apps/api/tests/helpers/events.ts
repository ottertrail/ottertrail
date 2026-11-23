import type { ClickHouseClient } from "../../src/clickhouse/clickhouse.ts";
import { fromClickHouseTime } from "../../src/clickhouse/query.ts";
import type { EventRow } from "../../src/collection/event-store.ts";
import { isRecord } from "../../src/enrichment/data-centers.ts";

type StoredRow = Omit<
  EventRow,
  | "occurred_at"
  | "received_at"
  | "path"
  | "properties"
  | "error_type"
  | "error_message"
  | "error_stack"
  | "error_handled"
  | "error_fingerprint"
> & {
  occurred_at: string;
  received_at: string;
  path: string;
  properties: string;
  error_type: string;
  error_message: string;
  error_stack: string;
  error_handled: boolean;
  error_fingerprint: string;
};

/**
 * Read with FINAL, oldest first, and restore the EventRow shape passed to storeEvents().
 */
export async function storedEvents(
  client: ClickHouseClient,
  projectId: string,
): Promise<EventRow[]> {
  const result = await client.query({
    query: `SELECT * FROM events FINAL WHERE project_id = {project:UUID}
            ORDER BY occurred_at, event_id`,
    query_params: { project: projectId },
    format: "JSONEachRow",
  });
  const rows = await result.json<StoredRow>();
  return rows.map((row) => {
    const isError = row.error_type !== "";
    const properties: unknown = JSON.parse(row.properties);
    return {
      ...row,
      occurred_at: fromClickHouseTime(row.occurred_at),
      received_at: fromClickHouseTime(row.received_at),
      path: row.path === "" ? null : row.path,
      properties: isRecord(properties) ? properties : {},
      error_type: isError ? row.error_type : null,
      error_message: isError ? row.error_message : null,
      error_stack: isError && row.error_stack !== "" ? row.error_stack : null,
      error_handled: isError ? row.error_handled : null,
      error_fingerprint: isError ? row.error_fingerprint : null,
    };
  });
}

/** Count with FINAL to exclude retry copies. */
export async function countEvents(client: ClickHouseClient, projectId: string): Promise<number> {
  const result = await client.query({
    query: "SELECT count() AS n FROM events FINAL WHERE project_id = {project:UUID}",
    query_params: { project: projectId },
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ n: string }>();
  return Number(row?.n ?? 0);
}
