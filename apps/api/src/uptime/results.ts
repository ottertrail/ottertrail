import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { insertRows } from "../clickhouse/insert.ts";
import {
  clickHouseTime,
  fromClickHouseTime,
  QueryParams,
  queryRows,
  type Reader,
} from "../clickhouse/query.ts";
import type { CheckCause } from "../db/schema.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import type { Buckets } from "../telemetry/metrics.ts";
import type { CheckOutcome } from "./request.ts";

/**
 * Check results in ClickHouse (check_results, clickhouse/migrations.ts): the worker
 * writes one per run, and a check's page reads its response times and
 * latest failures. Every query names the project first, then the check,
 * as the table is ordered.
 */

/** How long ClickHouse keeps results (the table's TTL). */
export const RESULT_RETENTION_DAYS = 90;

/** Writes one run's outcome: an asynchronous insert, waiting for the write, as events are. */
export async function storeResult(
  clickhouse: ClickHouseClient,
  check: { id: string; projectId: string },
  outcome: CheckOutcome,
  at: Date,
): Promise<void> {
  await insertRows(clickhouse, "check_results", [
    {
      project_id: check.projectId,
      check_id: check.id,
      timestamp: clickHouseTime(at),
      up: outcome.up,
      status_code: outcome.statusCode ?? 0,
      response_ms: outcome.responseMs,
      cause: outcome.cause ?? "",
      detail: outcome.detail.slice(0, 1000),
    },
  ]);
}

/** A check's response times over a range, in buckets, with how many runs failed. */
export interface ResponseChart {
  /** The first bucket's start. */
  start: Date;
  stepSeconds: number;
  buckets: number;
  /** The average response time of the runs that got an answer, per bucket; null where none did. */
  responseMs: (number | null)[];
  /** Runs in the range, and how many of them failed. */
  runs: number;
  failures: number;
}

export async function responseChart(
  reader: Reader,
  check: { id: string; projectId: string },
  buckets: Buckets,
): Promise<ResponseChart> {
  const params = new QueryParams();
  const project = params.add(check.projectId, "UUID");
  const checkId = params.add(check.id, "UUID");
  const first = params.add(buckets.firstMs, "Int64");
  const step = params.add(buckets.stepMs, "Int64");
  const rows = await queryRows<{
    bucket: string;
    response_ms: number | null;
    runs: string;
    failures: string;
  }>(
    reader,
    `SELECT intDiv(toUnixTimestamp64Milli(timestamp) - ${first}, ${step}) AS bucket,
       if(countIf(status_code > 0) = 0, NULL, avgIf(response_ms, status_code > 0)) AS response_ms,
       count() AS runs,
       countIf(NOT up) AS failures
     FROM check_results
     WHERE project_id = ${project} AND check_id = ${checkId}
       AND timestamp >= ${params.time(new Date(buckets.fromMs))}
       AND timestamp < ${params.time(new Date(buckets.endMs))}
     GROUP BY bucket
     ORDER BY bucket`,
    params,
    DASHBOARD_SETTINGS,
  );
  const responseMs: (number | null)[] = Array.from({ length: buckets.count }, () => null);
  let runs = 0;
  let failures = 0;
  for (const row of rows) {
    const index = Number(row.bucket);
    if (index >= 0 && index < buckets.count && row.response_ms !== null) {
      responseMs[index] = Math.round(row.response_ms);
    }
    runs += Number(row.runs);
    failures += Number(row.failures);
  }
  return {
    start: new Date(buckets.firstMs),
    stepSeconds: buckets.stepMs / 1000,
    buckets: buckets.count,
    responseMs,
    runs,
    failures,
  };
}

/** A run that failed, as a check's page lists it. */
export interface Failure {
  at: Date;
  statusCode: number | null;
  responseMs: number;
  cause: CheckCause;
  detail: string;
}

/** Failures listed on a check's page: the latest. */
export const MAX_FAILURES = 20;

/** A check's latest failed runs in [from, to), newest first. */
export async function latestFailures(
  reader: Reader,
  check: { id: string; projectId: string },
  from: Date,
  to: Date,
): Promise<Failure[]> {
  const params = new QueryParams();
  const rows = await queryRows<{
    timestamp: string;
    status_code: number;
    response_ms: number;
    cause: CheckCause;
    detail: string;
  }>(
    reader,
    `SELECT timestamp, status_code, response_ms, cause, detail
     FROM check_results
     WHERE project_id = ${params.add(check.projectId, "UUID")}
       AND check_id = ${params.add(check.id, "UUID")}
       AND timestamp >= ${params.time(from)} AND timestamp < ${params.time(to)}
       AND NOT up
     ORDER BY timestamp DESC
     LIMIT ${MAX_FAILURES}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.map((row) => ({
    at: fromClickHouseTime(row.timestamp),
    statusCode: row.status_code === 0 ? null : row.status_code,
    responseMs: row.response_ms,
    cause: row.cause,
    detail: row.detail,
  }));
}
