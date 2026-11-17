import { Buffer } from "node:buffer";

import type { Kysely } from "kysely";

import type { ClickHouseClient } from "../../src/clickhouse/clickhouse.ts";
import type { Database } from "../../src/db/schema.ts";
import type { SignalMessages } from "../../src/telemetry/proto/definitions.ts";

/** Now, in nanoseconds since 1970, as OTLP counts time. */
export function nowNs(offsetMs = 0): bigint {
  return BigInt(Date.now() + offsetMs) * 1_000_000n;
}

/** An OTLP attribute list from plain values: strings, whole numbers (int), other numbers (double), booleans. */
export function keyValues(values: Record<string, string | number | boolean>) {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value },
  }));
}

/** A request as protobuf bytes, built from the same definitions the API decodes with. */
export function encodeProtobuf(messages: SignalMessages, request: object): Buffer {
  const bytes = messages.request.encode(messages.request.fromObject(request)).finish();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** An answer's protobuf body, decoded. */
export function decodeResponse(
  type: SignalMessages["response"],
  body: Buffer,
): Record<string, unknown> {
  return type.toObject(type.decode(body), { longs: Number });
}

export async function secretKeyOf(db: Kysely<Database>, projectId: string): Promise<string> {
  const row = await db
    .selectFrom("projects")
    .select("secret_key")
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();
  return row.secret_key;
}

/** A project's rows of a telemetry table, one per ID (FINAL), oldest first. */
export async function storedRows<Row = Record<string, unknown>>(
  client: ClickHouseClient,
  table: "spans" | "logs" | "metric_points" | "metric_histograms",
  projectId: string,
): Promise<Row[]> {
  const result = await client.query({
    query: `SELECT * FROM ${table} FINAL WHERE project_id = {project:UUID} ORDER BY timestamp, id`,
    query_params: { project: projectId },
    format: "JSONEachRow",
  });
  return result.json<Row>();
}
