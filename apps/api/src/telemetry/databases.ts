import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  DASHBOARD_SETTINGS,
  hasAnyRow,
  labelsInRange,
  type TelemetryRange,
} from "./dashboard-query.ts";
import { SHAPE_KINDS, type ShapeKind } from "./db-shape.ts";
import { type Buckets, bucketSeconds, bucketsOf } from "./metrics.ts";
import { ROUTE, SERVICES_FINAL } from "./services.ts";

/**
 * Database calls are CLIENT spans with a database system attribute. Materialized columns supply
 * system, database, and shape (db-shape.ts; docs/telemetry.md, "Databases"). Reads omit FINAL
 * (SERVICES_FINAL); retries count until daily merges, forced within about an hour of the day's
 * last insert.
 */

/** Keeps databases with the most time spent; reports truncation. */
export const MAX_DATABASES = 50;
/** Per database, in the selected order. */
export const MAX_SHAPES = 200;
/** serviceCount includes services omitted by this cap. */
export const MAX_SHAPE_SERVICES = 10;
export const SLOWEST_CALLS = 20;
/** Latest calls sampled for request routes. */
export const ROUTE_SAMPLE = 1000;
export const MAX_CALLERS = 50;
/** Maximum request start lead before a database call. */
const REQUEST_LEAD_MS = 3_600_000;

export const DATABASE_SORTS = ["time", "p95", "calls", "failures"] as const;
export type DatabaseSort = (typeof DATABASE_SORTS)[number];

export interface CallScope {
  projectId: string;
  environment: string;
  from: Date;
  to: Date;
}

/**
 * PREWHERE filters narrow materialized columns before reading other fields (db-shape.ts, migration
 * 0003). shape_kind 1 to 3 maps to SHAPE_KINDS.
 */
export function databaseCalls(
  params: QueryParams,
  scope: CallScope,
  { final = SERVICES_FINAL, shapeId }: { final?: boolean; shapeId?: string | undefined } = {},
): string {
  return `
    SELECT timestamp, trace_id, span_id, service, status_code, duration_ns,
           db_system AS system, db_namespace AS database, db_shape_kind AS shape_kind,
           db_shape AS shape, db_shape_id AS shape_id
    FROM spans ${final ? "FINAL" : ""}
    PREWHERE project_id = ${params.add(scope.projectId, "UUID")}
      AND timestamp >= ${params.time(scope.from)} AND timestamp < ${params.time(scope.to)}
      AND kind = 'client' AND db_system != ''
      ${shapeId === undefined ? "" : `AND db_shape_id = ${params.add(shapeId, "UInt64")}`}
    WHERE environment = ${params.add(scope.environment, "String")}`;
}

export interface CallStats {
  calls: number;
  failed: number;
  /** Sum of call durations, in microseconds. */
  totalUs: number;
  /** Uses elapsed seconds before now; null if none. */
  perSecond: number | null;
  /** Interpolates between neighboring durations, as Services does. */
  p50Us: number;
  p95Us: number;
  p99Us: number;
  /** Up to MAX_SHAPE_SERVICES, sorted by name. */
  services: string[];
  serviceCount: number;
}

export interface ShapeSummary extends CallStats {
  /** Decimal hash of system, database, kind, and shape, used in the page URL. */
  id: string;
  kind: ShapeKind;
  shape: string;
}

export interface DatabaseSummary extends CallStats {
  system: string;
  /** '' when the calls name none. */
  database: string;
  /** Includes shapes omitted by the cap. */
  shapeCount: number;
  shapes: ShapeSummary[];
}

interface StatsRow {
  calls: string;
  failed: string;
  total_ns: string;
  durations: number[];
  services: string[];
  service_count: string;
}

interface ListRow extends StatsRow {
  system: string;
  database: string;
  whole: number | string;
  id: string;
  shape: string;
  shape_kind: number | string;
  shapes: string;
}

const kindOf = (value: number | string): ShapeKind => SHAPE_KINDS[Number(value) - 1] ?? "operation";

function secondsOf(range: Pick<TelemetryRange, "from" | "to">, now: Date): number {
  const end = Math.min(range.to.getTime(), now.getTime());
  return Math.max(0, end - range.from.getTime()) / 1000;
}

function statsOf(row: StatsRow, seconds: number): CallStats {
  const calls = Number(row.calls);
  const [p50 = 0, p95 = 0, p99 = 0] = calls === 0 ? [] : row.durations;
  return {
    calls,
    failed: Number(row.failed),
    totalUs: Number(row.total_ns) / 1000,
    perSecond: seconds > 0 ? calls / seconds : null,
    p50Us: p50 / 1000,
    p95Us: p95 / 1000,
    p99Us: p99 / 1000,
    services: row.services.toSorted((a, b) => a.localeCompare(b)),
    serviceCount: Number(row.service_count),
  };
}

/** Descending sort expressions. Constants only. */
const SORT_KEYS: Record<DatabaseSort, string> = {
  time: "total_ns DESC",
  p95: "durations[2] DESC",
  calls: "calls DESC",
  failures: "failed DESC, calls DESC",
};

const STATS_COLUMNS = `count() AS calls, countIf(status_code = 'error') AS failed,
  sum(duration_ns) AS total_ns,
  quantilesExactInclusive(0.5, 0.95, 0.99)(duration_ns) AS durations,
  groupUniqArray(${MAX_SHAPE_SERVICES})(service) AS services, uniq(service) AS service_count`;

/**
 * Ranks databases by time spent and shapes by `sort` in one read, using GROUPING SETS and window
 * functions.
 */
export async function listDatabases(
  reader: Reader,
  range: TelemetryRange,
  sort: DatabaseSort,
  now: Date,
  { final = SERVICES_FINAL }: { final?: boolean } = {},
): Promise<{
  databases: DatabaseSummary[];
  /** Keeps the MAX_DATABASES with most time spent. */
  truncated: boolean;
  environments: string[];
  received: boolean;
  seconds: number;
}> {
  const params = new QueryParams();
  const [rows, labels] = await Promise.all([
    queryRows<ListRow>(
      reader,
      `SELECT system, database, whole, id, shape, shape_kind, shapes,
              calls, failed, total_ns, durations, services, service_count
       FROM (
         SELECT *,
                dense_rank() OVER (ORDER BY database_ns DESC, system, database) AS database_rank,
                row_number() OVER (PARTITION BY system, database, whole
                                   ORDER BY ${SORT_KEYS[sort]}, id) AS shape_rank
         FROM (
           SELECT *, max(if(whole = 1, total_ns, 0)) OVER (PARTITION BY system, database) AS database_ns
           FROM (
             SELECT system, database, grouping(shape_id) AS whole, toString(shape_id) AS id,
                    any(shape) AS shape, any(shape_kind) AS shape_kind,
                    uniq(shape_id) AS shapes,
                    ${STATS_COLUMNS}
             FROM (${databaseCalls(params, range, { final })})
             GROUP BY GROUPING SETS ((system, database), (system, database, shape_id))
           )
         )
       )
       WHERE database_rank <= ${MAX_DATABASES + 1} AND (whole = 1 OR shape_rank <= ${MAX_SHAPES + 1})
       ORDER BY database_rank, whole DESC, shape_rank
       LIMIT ${(MAX_DATABASES + 1) * (MAX_SHAPES + 2)}`,
      params,
      DASHBOARD_SETTINGS,
    ),
    labelsInRange(reader, "spans", range, "AND kind = 'client'"),
  ]);
  const seconds = secondsOf(range, now);
  const databases: (DatabaseSummary & { cut: boolean })[] = [];
  for (const row of rows) {
    if (String(row.whole) === "1") {
      databases.push({
        system: row.system,
        database: row.database,
        ...statsOf(row, seconds),
        shapeCount: Number(row.shapes),
        shapes: [],
        cut: false,
      });
      continue;
    }
    const current = databases.at(-1);
    if (current?.system !== row.system || current.database !== row.database) continue;
    if (current.shapes.length >= MAX_SHAPES) {
      current.cut = true;
      continue;
    }
    current.shapes.push({
      id: row.id,
      kind: kindOf(row.shape_kind),
      shape: row.shape,
      ...statsOf(row, seconds),
    });
  }
  return {
    databases: databases.slice(0, MAX_DATABASES).map(({ cut, ...database }) => ({
      ...database,
      // uniq is approximate past 65,536; the cut is exact.
      shapeCount: cut ? Math.max(database.shapeCount, MAX_SHAPES + 1) : database.shapes.length,
    })),
    truncated: databases.length > MAX_DATABASES,
    environments: labels.environments,
    received: databases.length > 0 || (await hasAnyRow(reader, "spans", range.projectId)),
    seconds,
  };
}

export interface DatabasesTrend {
  start: Date;
  stepSeconds: number;
  buckets: number;
  /** Buckets sum to these totals, matching the database list. */
  totals: { calls: number; failed: number; totalUs: number; perSecond: number | null };
  /** Per-bucket counts and summed durations in microseconds. */
  counts: { calls: number[]; failed: number[]; totalUs: number[] };
  /** Uses bucket seconds within the range and before now. */
  perSecond: (number | null)[];
}

interface TrendRow {
  /** "1" for the row of the whole range. */
  whole: string | number;
  bucket: string | number;
  calls: string;
  failed: string;
  total_ns: string;
}

/**
 * GROUPING SETS reads totals and buckets together with one aggregate row per bucket. Late calls
 * join the last bucket so sums agree. Omits FINAL (SERVICES_FINAL).
 */
export async function databasesTrend(
  reader: Reader,
  range: TelemetryRange,
  now: Date,
  { final = SERVICES_FINAL }: { final?: boolean } = {},
): Promise<DatabasesTrend> {
  const buckets = bucketsOf(range, now);
  const params = new QueryParams();
  const rows =
    buckets.count === 0
      ? []
      : await queryRows<TrendRow>(
          reader,
          `SELECT grouping(bucket) AS whole, bucket,
                  count() AS calls, countIf(status_code = 'error') AS failed,
                  sum(duration_ns) AS total_ns
           FROM (
             SELECT least(greatest(intDiv(toUnixTimestamp64Milli(timestamp) - ${params.add(buckets.firstMs, "Int64")},
                                          ${params.add(buckets.stepMs, "Int64")}), 0),
                          ${params.add(buckets.count - 1, "Int64")}) AS bucket,
                    status_code, duration_ns
             FROM (${databaseCalls(params, range, { final })})
           )
           GROUP BY GROUPING SETS ((), (bucket))
           ORDER BY whole DESC, bucket
           LIMIT ${buckets.count + 1}`,
          params,
          DASHBOARD_SETTINGS,
        );
  const blank = () => Array.from({ length: buckets.count }, () => 0);
  const counts = { calls: blank(), failed: blank(), totalUs: blank() };
  const seconds = secondsOf(range, now);
  let totals: DatabasesTrend["totals"] = {
    calls: 0,
    failed: 0,
    totalUs: 0,
    perSecond: seconds > 0 ? 0 : null,
  };
  for (const row of rows) {
    const calls = Number(row.calls);
    if (String(row.whole) === "1") {
      totals = {
        calls,
        failed: Number(row.failed),
        totalUs: Number(row.total_ns) / 1000,
        perSecond: seconds > 0 ? calls / seconds : null,
      };
      continue;
    }
    const index = Number(row.bucket);
    if (index < 0 || index >= buckets.count) continue;
    counts.calls[index] = calls;
    counts.failed[index] = Number(row.failed);
    counts.totalUs[index] = Number(row.total_ns) / 1000;
  }
  return {
    start: new Date(buckets.firstMs),
    stepSeconds: buckets.stepMs / 1000,
    buckets: buckets.count,
    totals,
    counts,
    perSecond: counts.calls.map((calls, index) => {
      const length = bucketSeconds(buckets, index);
      return length > 0 ? calls / length : null;
    }),
  };
}

export interface SlowCall {
  traceId: string;
  spanId: string;
  /** ISO, to the millisecond. */
  start: string;
  /** Nanoseconds since 1970, used for span lookup. */
  startNs: string;
  durationUs: number;
  service: string;
  failed: boolean;
}

export interface ShapeCaller {
  service: string;
  /** Null if no request span matched the trace and service, e.g. a background job. */
  route: string | null;
  calls: number;
}

export interface ShapeDetail {
  id: string;
  /** Null without calls in the range. */
  shape: {
    kind: ShapeKind;
    text: string;
    system: string;
    database: string;
  } | null;
  start: Date;
  stepSeconds: number;
  buckets: number;
  /** Buckets sum to these totals, matching the database list. */
  totals: CallStats;
  counts: { calls: number[]; failed: number[] };
  /** Uses bucket seconds within the range and before now. */
  perSecond: (number | null)[];
  /** 0 to 1; null without a call. */
  failedShare: (number | null)[];
  /** In microseconds; null without a call. */
  durations: { p50Us: (number | null)[]; p95Us: (number | null)[]; p99Us: (number | null)[] };
  /** Most calls first. */
  services: (Omit<CallStats, "services" | "serviceCount"> & { service: string })[];
  servicesTruncated: boolean;
  slowest: SlowCall[];
  /** Routes sampled from the latest ROUTE_SAMPLE calls. */
  callers: ShapeCaller[];
  sampled: number;
}

interface ShapeRow extends StatsRow {
  no_bucket: number | string;
  no_service: number | string;
  bucket: number | string;
  service: string;
  system: string;
  database: string;
  shape: string;
  shape_kind: number | string;
  /** (−duration, start ns, trace, span, service, status), slowest first; only in the whole range's row. */
  slowest: [string, string, string, string, string, string][];
}

/**
 * GROUPING SETS reads buckets, totals, and per-service stats together. Late calls join the last
 * bucket so sums agree with the database list.
 *
 * Samples ROUTE_SAMPLE calls from the latest buckets containing that many, avoiding normalizing
 * the full range. Request spans match trace and service within the hour before the calls.
 */
export async function shapeDetail(
  reader: Reader,
  range: TelemetryRange,
  id: string,
  now: Date,
  { final = SERVICES_FINAL }: { final?: boolean } = {},
): Promise<ShapeDetail> {
  const buckets = bucketsOf(range, now);
  const seconds = secondsOf(range, now);
  const params = new QueryParams();
  const rows = await queryRows<ShapeRow>(
    reader,
    `SELECT grouping(bucket) AS no_bucket, grouping(service) AS no_service, bucket, service,
              any(system) AS system, any(database) AS database,
              any(shape) AS shape, any(shape_kind) AS shape_kind,
              ${STATS_COLUMNS},
              if(no_bucket = 1 AND no_service = 1,
                 arrayMap(call -> (toString(call.1), toString(call.2), call.3, call.4, call.5, call.6),
                          groupArraySorted(${SLOWEST_CALLS})(
                            (-toInt64(duration_ns), toUnixTimestamp64Nano(timestamp),
                             trace_id, span_id, toString(service), toString(status_code)))),
                 []) AS slowest
       FROM (
         SELECT least(greatest(intDiv(toUnixTimestamp64Milli(timestamp) - ${params.add(buckets.firstMs, "Int64")},
                                      ${params.add(buckets.stepMs, "Int64")}), 0),
                      ${params.add(Math.max(buckets.count - 1, 0), "Int64")}) AS bucket,
                *
         FROM (${databaseCalls(params, range, { final, shapeId: id })})
       )
       GROUP BY GROUPING SETS ((), (bucket), (service))
       ORDER BY no_bucket + no_service DESC, no_service DESC, bucket, calls DESC, service
       LIMIT ${buckets.count + MAX_CALLERS + 2}`,
    params,
    DASHBOARD_SETTINGS,
  );

  const blank = <T>(fill: T) => Array.from({ length: buckets.count }, () => fill);
  const counts = { calls: blank(0), failed: blank(0) };
  const durations: ShapeDetail["durations"] = {
    p50Us: blank<number | null>(null),
    p95Us: blank<number | null>(null),
    p99Us: blank<number | null>(null),
  };
  const empty: StatsRow = {
    calls: "0",
    failed: "0",
    total_ns: "0",
    durations: [],
    services: [],
    service_count: "0",
  };
  let totals = statsOf(empty, seconds);
  let shape: ShapeDetail["shape"] = null;
  let slowest: SlowCall[] = [];
  const services: ShapeDetail["services"] = [];
  for (const row of rows) {
    const noBucket = String(row.no_bucket) === "1";
    const noService = String(row.no_service) === "1";
    if (noBucket && noService) {
      totals = statsOf(row, seconds);
      if (totals.calls > 0) {
        shape = {
          kind: kindOf(row.shape_kind),
          text: row.shape,
          system: row.system,
          database: row.database,
        };
      }
      slowest = row.slowest.map(([negative, ns, traceId, spanId, service, status]) => ({
        traceId,
        spanId,
        start: new Date(Number(BigInt(ns) / 1_000_000n)).toISOString(),
        startNs: ns,
        durationUs: -Number(negative) / 1000,
        service,
        failed: status === "error",
      }));
    } else if (noService) {
      const index = Number(row.bucket);
      if (index < 0 || index >= buckets.count) continue;
      const stats = statsOf(row, 0);
      counts.calls[index] = stats.calls;
      counts.failed[index] = stats.failed;
      durations.p50Us[index] = stats.p50Us;
      durations.p95Us[index] = stats.p95Us;
      durations.p99Us[index] = stats.p99Us;
    } else if (services.length < MAX_CALLERS) {
      const { services: _, serviceCount: __, ...stats } = statsOf(row, seconds);
      services.push({ service: row.service, ...stats });
    }
  }
  const bucketLengths = Array.from({ length: buckets.count }, (_, index) =>
    bucketSeconds(buckets, index),
  );
  return {
    id,
    shape,
    start: new Date(buckets.firstMs),
    stepSeconds: buckets.stepMs / 1000,
    buckets: buckets.count,
    totals,
    counts,
    perSecond: counts.calls.map((calls, index) => {
      const length = bucketLengths[index] ?? 0;
      return length > 0 ? calls / length : null;
    }),
    failedShare: counts.calls.map((calls, index) =>
      calls === 0 ? null : (counts.failed[index] ?? 0) / calls,
    ),
    durations,
    services,
    servicesTruncated: totals.serviceCount > services.length,
    slowest,
    ...(await callersOf(reader, range, id, latestBuckets(buckets, counts.calls), { final })),
  };
}

/** Earliest bucket needed for ROUTE_SAMPLE latest calls, or null without calls. */
function latestBuckets(buckets: Buckets, calls: readonly number[]): Date | null {
  let seen = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    seen += calls[index] ?? 0;
    if (seen >= ROUTE_SAMPLE) return new Date(buckets.firstMs + index * buckets.stepMs);
  }
  return seen === 0 ? null : new Date(buckets.firstMs);
}

/**
 * Matches each sampled call to the earliest server span of its trace and service, from an hour
 * before the earliest call to the latest. Unmatched calls have no route.
 *
 * PREWHERE on db_shape_id bounds sorting to one shape. Read-in-order over unmerged parts held a
 * block from every part in memory. Sparse shapes scan the full range's db_shape_id column (50
 * calls in 6 million weekly spans: 4 to 28 ms).
 */
async function callersOf(
  reader: Reader,
  range: TelemetryRange,
  id: string,
  since: Date | null,
  { final }: { final: boolean },
): Promise<{ callers: ShapeCaller[]; sampled: number }> {
  if (since === null) return { callers: [], sampled: 0 };
  const sampleParams = new QueryParams();
  const from = since > range.from ? since : range.from;
  const sample = await queryRows<{ trace_id: string; service: string; ns: string }>(
    reader,
    `SELECT trace_id, toString(service) AS service, toString(toUnixTimestamp64Nano(timestamp)) AS ns
     FROM (${databaseCalls(sampleParams, { ...range, from }, { final, shapeId: id })})
     ORDER BY timestamp DESC
     LIMIT ${ROUTE_SAMPLE}`,
    sampleParams,
    { ...DASHBOARD_SETTINGS, optimize_read_in_order: 0 },
  );
  if (sample.length === 0) return { callers: [], sampled: 0 };
  const times = sample.map((call) => BigInt(call.ns));
  const earliest = times.reduce((a, b) => (b < a ? b : a));
  const latest = times.reduce((a, b) => (b > a ? b : a));
  const params = new QueryParams();
  const requests = await queryRows<{ trace_id: string; service: string; route: string }>(
    reader,
    `SELECT trace_id, toString(service) AS service, argMin(route, timestamp) AS route
     FROM (
       SELECT trace_id, service, timestamp, ${ROUTE} AS route
       FROM spans ${final ? "FINAL" : ""}
       PREWHERE project_id = ${params.add(range.projectId, "UUID")}
         AND timestamp >= fromUnixTimestamp64Nano(${params.add(
           (earliest - BigInt(REQUEST_LEAD_MS) * 1_000_000n).toString(),
           "Int64",
         )}, 'UTC')
         AND timestamp <= fromUnixTimestamp64Nano(${params.add(latest.toString(), "Int64")}, 'UTC')
         AND kind = 'server'
         AND trace_id IN ${params.add([...new Set(sample.map((call) => call.trace_id))], "Array(String)")}
       WHERE environment = ${params.add(range.environment, "String")}
     )
     GROUP BY trace_id, service
     LIMIT ${ROUTE_SAMPLE * 2}`,
    params,
    DASHBOARD_SETTINGS,
  );
  const routeOf = new Map(
    requests.map((row) => [JSON.stringify([row.trace_id, row.service]), row.route]),
  );
  const counted = new Map<string, ShapeCaller>();
  for (const call of sample) {
    const route = routeOf.get(JSON.stringify([call.trace_id, call.service])) ?? null;
    const key = JSON.stringify([call.service, route]);
    const caller = counted.get(key) ?? { service: call.service, route, calls: 0 };
    caller.calls += 1;
    counted.set(key, caller);
  }
  const callers = [...counted.values()]
    .toSorted(
      (a, b) =>
        b.calls - a.calls ||
        a.service.localeCompare(b.service) ||
        (a.route ?? "").localeCompare(b.route ?? ""),
    )
    .slice(0, MAX_CALLERS);
  return { callers, sampled: sample.length };
}
