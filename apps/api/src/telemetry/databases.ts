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
 * The dashboard's Databases page and a query shape's page
 * (docs/telemetry.md, "Databases"): the database calls inside traces,
 * grouped by database and query shape, with their calls, time spent,
 * durations, and failures over the period.
 *
 * A database call is a span of kind CLIENT with a database system
 * attribute; ClickHouse works out its system, database, and query shape
 * when the span is written (db-shape.ts). Spans are read without
 * FINAL, as the Services pages read them (SERVICES_FINAL): a retried span
 * counts twice until its day is merged, which the spans table forces
 * within about an hour of the day's last insert.
 */

/** Databases listed, those with the most time spent; past this, the page says it was cut. */
export const MAX_DATABASES = 50;
/** Query shapes listed per database, the first by the chosen order. */
export const MAX_SHAPES = 200;
/** The services named per shape; serviceCount says how many there are. */
export const MAX_SHAPE_SERVICES = 10;
/** The slowest calls a shape's page lists. */
export const SLOWEST_CALLS = 20;
/** The latest calls a shape's page looks up the routes of. */
export const ROUTE_SAMPLE = 1000;
/** Routes and services listed on a shape's page. */
export const MAX_CALLERS = 50;
/** How long before a call its request may have started, at most, to be found. */
const REQUEST_LEAD_MS = 3_600_000;

export const DATABASE_SORTS = ["time", "p95", "calls", "failures"] as const;
export type DatabaseSort = (typeof DATABASE_SORTS)[number];

/** Which calls to read: a project's, in one environment, in [from, to), and of one shape when given. */
export interface CallScope {
  projectId: string;
  environment: string;
  from: Date;
  to: Date;
}

/**
 * The database calls in scope: their time, trace, span, service, status,
 * duration, system, database, and query shape, from the columns ClickHouse
 * worked out when each span was written (db-shape.ts, migration 0003):
 * `shape_kind` 1 to 3 for SHAPE_KINDS, and `shape_id`, which names the
 * shape in an address.
 *
 * PREWHERE reads the project's spans of the range that are database
 * calls (and of the shape, when one is named) from these narrow columns
 * before anything else.
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
  /** The time all the calls took, added up, in microseconds. */
  totalUs: number;
  /** Calls per second over the period's seconds before now; null for a period with none. */
  perSecond: number | null;
  /** Interpolated between the two nearest durations, as the Services page's. */
  p50Us: number;
  p95Us: number;
  p99Us: number;
  /** Up to MAX_SHAPE_SERVICES of the services that made the calls, by name. */
  services: string[];
  serviceCount: number;
}

export interface ShapeSummary extends CallStats {
  /** A hash of the system, database, kind, and shape, as decimal text: the shape page's address. */
  id: string;
  kind: ShapeKind;
  shape: string;
}

export interface DatabaseSummary extends CallStats {
  system: string;
  /** '' when the calls name none. */
  database: string;
  /** All its shapes in the range: more than `shapes` holds when it was cut. */
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

/** The seconds of the range before now, for calls per second. */
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

/** What each sort orders a database's shapes by, largest first. Constants, never input. */
const SORT_KEYS: Record<DatabaseSort, string> = {
  time: "total_ns DESC",
  p95: "durations[2] DESC",
  calls: "calls DESC",
  failures: "failed DESC, calls DESC",
};

/** The aggregates of each group of calls (StatsRow). */
const STATS_COLUMNS = `count() AS calls, countIf(status_code = 'error') AS failed,
  sum(duration_ns) AS total_ns,
  quantilesExactInclusive(0.5, 0.95, 0.99)(duration_ns) AS durations,
  groupUniqArray(${MAX_SHAPE_SERVICES})(service) AS services, uniq(service) AS service_count`;

/**
 * Each database of the range (system and name), the MAX_DATABASES with
 * the most time spent, with its MAX_SHAPES first shapes by `sort`, in one
 * read: GROUPING SETS for the databases and their shapes at once, then
 * window functions rank the databases by time and each one's shapes.
 */
export async function listDatabases(
  reader: Reader,
  range: TelemetryRange,
  sort: DatabaseSort,
  now: Date,
  { final = SERVICES_FINAL }: { final?: boolean } = {},
): Promise<{
  databases: DatabaseSummary[];
  /** More than MAX_DATABASES databases: the list holds those with the most time spent. */
  truncated: boolean;
  environments: string[];
  /** Whether the project has sent any span at all. */
  received: boolean;
  /** The seconds calls per second are counted over. */
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

/** Every database call of the range together, in time buckets: the Databases page's charts. */
export interface DatabasesTrend {
  /** The first bucket's start. */
  start: Date;
  stepSeconds: number;
  buckets: number;
  /** The whole range, counted as the Databases page counts it: the buckets add up to these. */
  totals: { calls: number; failed: number; totalUs: number; perSecond: number | null };
  /** Per bucket: the calls, the failed ones, and the time they took, added up, in microseconds. */
  counts: { calls: number[]; failed: number[]; totalUs: number[] };
  /** Calls per second, over the bucket's seconds within the range and before now. */
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
 * Every database call of the project's environment over the range, in
 * the buckets a metric's chart would have (bucketsOf), and over the whole
 * range, in one read (GROUPING SETS ((), (bucket))): the calls, failed
 * calls, and time spent. Only counts and sums, so the read keeps one row
 * per bucket, not each call's duration. A call later than the last
 * bucket counts in the last, so the buckets add up to the totals, which
 * are the Databases page's databases added up. Read without FINAL, as the
 * list is (SERVICES_FINAL).
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

/** One of a shape's slowest calls: where it is on the trace page. */
export interface SlowCall {
  traceId: string;
  spanId: string;
  /** ISO, to the millisecond. */
  start: string;
  /** Nanoseconds since 1970, as text: the span's key. */
  startNs: string;
  durationUs: number;
  service: string;
  failed: boolean;
}

/** A route of the requests that made a shape's calls, from its latest calls. */
export interface ShapeCaller {
  service: string;
  /** null: no request of the service was found in the call's trace, such as a background job's. */
  route: string | null;
  calls: number;
}

export interface ShapeDetail {
  id: string;
  /** null: no call of the shape in the range. */
  shape: {
    kind: ShapeKind;
    text: string;
    system: string;
    database: string;
  } | null;
  start: Date;
  stepSeconds: number;
  buckets: number;
  /** The whole range, counted as the Databases page counts it: the buckets add up to these. */
  totals: CallStats;
  counts: { calls: number[]; failed: number[] };
  /** Calls per second, over the bucket's seconds within the range and before now. */
  perSecond: (number | null)[];
  /** 0 to 1; null without a call. */
  failedShare: (number | null)[];
  /** In microseconds; null without a call. */
  durations: { p50Us: (number | null)[]; p95Us: (number | null)[]; p99Us: (number | null)[] };
  /** The services that made its calls, most calls first, with their numbers. */
  services: (Omit<CallStats, "services" | "serviceCount"> & { service: string })[];
  servicesTruncated: boolean;
  slowest: SlowCall[];
  /** The routes of the requests of up to ROUTE_SAMPLE latest calls. */
  callers: ShapeCaller[];
  /** How many calls the callers were found from. */
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
 * One shape's calls over the range: in the buckets a metric's chart would
 * have (bucketsOf), over the whole range, and per service, in one read
 * (GROUPING SETS ((), (bucket), (service))), with its SLOWEST_CALLS slowest
 * calls in the whole range's row. A call later than the last bucket counts
 * in the last, so the buckets add up to the totals, which are the
 * Databases page's for the same range.
 *
 * Then the routes that called it: its ROUTE_SAMPLE latest calls, read
 * only from the latest buckets that hold that many (so a second read
 * normalizes a few buckets' calls, not the range's), and the requests
 * (server spans) of the same trace and service, found by trace ID within
 * the hour before those calls.
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

/**
 * Where the latest ROUTE_SAMPLE calls are: the start of the latest
 * buckets that hold that many, or of the first; null for none.
 */
function latestBuckets(buckets: Buckets, calls: readonly number[]): Date | null {
  let seen = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    seen += calls[index] ?? 0;
    if (seen >= ROUTE_SAMPLE) return new Date(buckets.firstMs + index * buckets.stepMs);
  }
  return seen === 0 ? null : new Date(buckets.firstMs);
}

/**
 * The routes of the requests that made a shape's latest calls: the
 * ROUTE_SAMPLE latest from `since` (latestBuckets), then for each, the
 * earliest server span of its trace and service, found by trace ID (the
 * bloom filter) between an hour before the earliest call and the latest.
 * A call without one counts under no route.
 *
 * The sample is read without read-in-order: PREWHERE on db_shape_id
 * leaves only the shape's rows, a few buckets' for a busy shape, so
 * sorting them costs little, where newest first over many unmerged parts
 * kept a block of every part in memory. A shape with fewer calls than
 * the sample is read over the whole range: its rows are found from the
 * db_shape_id column alone (50 calls in a week of 6 million spans: 4 to
 * 28 ms).
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
