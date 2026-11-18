import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  DASHBOARD_SETTINGS,
  hasAnyRow,
  labelsInRange,
  type TelemetryRange,
} from "./dashboard-query.ts";
import { bucketSeconds, bucketsOf } from "./metrics.ts";

/**
 * The dashboard's Services page and a service's or route's page
 * (docs/telemetry.md, "How services are counted"): for each service, and
 * each route of its server spans, the requests in the range, the share
 * that failed, the median, 95th, and 99th-percentile duration, and the
 * requests by status class; and one service or route over the range, in
 * time buckets.
 *
 * A request is a span of kind SERVER. Its route is its `http.route`
 * attribute, else its name. Spans are read without FINAL (SERVICES_FINAL):
 * a retried span counts twice, on the list and the charts alike (so the
 * two agree), until its day is merged. ClickHouse merges when it decides,
 * so the spans table forces it within about an hour of the day's last
 * insert (FORCE_MERGE_SECONDS, migration 0002 in clickhouse/migrations.ts).
 */

/**
 * Whether the Services pages read FINAL. They do not: on a busy project
 * with many unmerged parts, FINAL's merge passed the 300 MB a query
 * may use (measured in docs/telemetry.md, "How services are counted").
 */
export const SERVICES_FINAL = false;

/** A request's status class, from its HTTP status code; "none" without one in 200–599. */
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "none"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];
export type StatusCounts = Record<StatusClass, number>;

/**
 * A request's HTTP status code: `http.response.status_code`, else the
 * older `http.status_code`.
 */
const STATUS_CODE =
  "if(attributes['http.response.status_code'] != '', attributes['http.response.status_code'], attributes['http.status_code'])";
/** Its class as a digit, 2 to 5; 0 for no code, or one that is not a number from 200 to 599. */
const STATUS_DIGIT = `transform(intDiv(toUInt32OrZero(${STATUS_CODE}), 100), [2, 3, 4, 5], [2, 3, 4, 5], 0)`;

/** Each class's count, as columns s2 … s5 and s0 of a grouped query. */
const STATUS_COLUMNS =
  "countIf(status_class = 2) AS s2, countIf(status_class = 3) AS s3, countIf(status_class = 4) AS s4, countIf(status_class = 5) AS s5, countIf(status_class = 0) AS s0";

interface StatusRow {
  s2: string;
  s3: string;
  s4: string;
  s5: string;
  s0: string;
}

const statusesOf = (row: StatusRow): StatusCounts => ({
  "2xx": Number(row.s2),
  "3xx": Number(row.s3),
  "4xx": Number(row.s4),
  "5xx": Number(row.s5),
  none: Number(row.s0),
});

/** Routes listed per service, those with the most requests; routeCount says how many there are. */
export const MAX_ROUTES = 100;
/** Services listed, by name; past this, the page says it was cut. */
export const MAX_SERVICES = 200;

export interface RouteStats {
  requests: number;
  failed: number;
  /** Interpolated between the two nearest durations (quantileExactInclusive), as the Speed page's p75. */
  p50Us: number;
  p95Us: number;
  p99Us: number;
  /** The requests by status class; they add up to `requests`. */
  statuses: StatusCounts;
}

export interface ServiceSummary extends RouteStats {
  service: string;
  /** All its routes in the range: more than `routes` holds when it was cut. */
  routeCount: number;
  routes: (RouteStats & { route: string })[];
}

interface CountRow extends StatusRow {
  service: string;
  /** A hash of the service and route, as text; the second query finds the route's name and durations by it. */
  route_id: string;
  /** "1" for the service's own row, which adds up all its routes (UInt64, as text). */
  whole: string;
  requests: string;
  failed: string;
  routes: string;
}

interface DurationRow {
  service: string;
  /** null: the service's own row; a route's ID only for the routes listed. */
  route_id: string | null;
  route: string;
  durations: number[];
}

/** A request's route: its `http.route` attribute, else its name. */
export const ROUTE = "if(attributes['http.route'] != '', attributes['http.route'], name)";

/** Which requests to read: a project's, in one environment, in [from, to), optionally one service's and route's. */
export interface SpanScope {
  projectId: string;
  environment: string;
  from: Date;
  to: Date;
  service?: string | undefined;
  /** null or undefined: every route of the service. */
  route?: string | null | undefined;
}

/**
 * The requests in scope (each once only with `final`): their time,
 * service, route, status, status class (STATUS_DIGIT), and duration. The
 * Services page and a service's or route's charts count from this.
 *
 * PREWHERE reads the project's rows of the range, and of the service when
 * one is named, before anything else: a span's attributes, for its route
 * and status code, are read only for those.
 */
export function serverSpans(
  params: QueryParams,
  scope: SpanScope,
  { final = SERVICES_FINAL } = {},
): string {
  return `
    SELECT timestamp, service, ${ROUTE} AS route, status_code, ${STATUS_DIGIT} AS status_class,
           duration_ns
    FROM spans ${final ? "FINAL" : ""}
    PREWHERE project_id = ${params.add(scope.projectId, "UUID")}
      AND timestamp >= ${params.time(scope.from)} AND timestamp < ${params.time(scope.to)}
      ${scope.service === undefined ? "" : `AND service = ${params.add(scope.service, "String")}`}
    WHERE environment = ${params.add(scope.environment, "String")}
      AND kind = 'server'
      ${
        scope.route === undefined || scope.route === null
          ? ""
          : `AND ${ROUTE} = ${params.add(scope.route, "String")}`
      }`;
}

/** One service's, or one route's, requests over a window. */
export interface WindowStats {
  requests: number;
  failed: number;
  /** null without a request. Interpolated, as the Services page's. */
  p95Us: number | null;
  p99Us: number | null;
}

/** A route rule's requests: one service's, of one route or all (null). */
export interface RouteTarget {
  service: string;
  route: string | null;
}

/** A target over its own window, which ends where the read does. */
export interface WindowTarget extends RouteTarget {
  from: Date;
}

/**
 * The requests of each target (a service, or one of its routes) in its
 * window, all ending at `to`, of one environment, all in one read of the
 * longest window: how many,
 * how many failed, and their 95th and 99th percentile duration, counted
 * as the Services page counts them (a SERVER span; its route its
 * `http.route`, else its name), each target with its own -If combinators.
 *
 * PREWHERE keeps the read to the targets' services before anything else
 * is read; a span's attributes, for its route, are read only for those,
 * and only when a target names a route.
 *
 * Read without FINAL (`final` false, as the alert rules read it): a
 * retried copy counts twice in the window until its day is merged (forced
 * within about an hour of the day's last insert, migration 0002), which
 * barely moves a share or a percentile, and FINAL's merge of every part
 * of a busy window costs far more (docs/uptime-alerts.md, step 4).
 */
export async function routeWindows(
  reader: Reader,
  scope: { projectId: string; environment: string; to: Date },
  targets: readonly WindowTarget[],
  { final = false }: { final?: boolean } = {},
): Promise<WindowStats[]> {
  if (targets.length === 0) return [];
  const params = new QueryParams();
  const services = [...new Set(targets.map((target) => target.service))];
  const from = new Date(Math.min(...targets.map((target) => target.from.getTime())));
  const condition = (target: WindowTarget) =>
    `timestamp >= ${params.time(target.from)} AND service = ${params.add(target.service, "String")}${
      target.route === null ? "" : ` AND route = ${params.add(target.route, "String")}`
    }`;
  // The aliases are built from the index, never from input.
  const columns = targets.map((target, index) => {
    const where = condition(target);
    return `countIf(${where}) AS r${index},
            countIf(${where} AND status_code = 'error') AS f${index},
            quantilesExactInclusiveIf(0.95, 0.99)(duration_ns, ${where}) AS d${index}`;
  });
  const [row] = await queryRows<Record<string, string | number[]>>(
    reader,
    `SELECT ${columns.join(",\n")}
     FROM (
       SELECT timestamp, service, ${ROUTE} AS route, status_code, duration_ns
       FROM spans ${final ? "FINAL" : ""}
       PREWHERE project_id = ${params.add(scope.projectId, "UUID")}
         AND timestamp >= ${params.time(from)} AND timestamp < ${params.time(scope.to)}
         AND service IN ${params.add(services, "Array(String)")}
       WHERE environment = ${params.add(scope.environment, "String")}
         AND kind = 'server'
     )`,
    params,
    DASHBOARD_SETTINGS,
  );
  return targets.map((_, index) => {
    const requests = Number(row?.[`r${index}`] ?? 0);
    const durations = row?.[`d${index}`];
    const [p95, p99] = Array.isArray(durations) ? durations : [];
    return {
      requests,
      failed: Number(row?.[`f${index}`] ?? 0),
      p95Us: requests === 0 || p95 === undefined ? null : p95 / 1000,
      p99Us: requests === 0 || p99 === undefined ? null : p99 / 1000,
    };
  });
}

/**
 * Whether any request of the service (and route) arrived in [from, to):
 * first whether the service sent any span at all, from the narrow columns
 * only; then, for a route, one of its requests, its spans' attributes read
 * only for the service's.
 */
export async function requestsSeen(
  reader: Reader,
  scope: SpanScope & { service: string },
): Promise<boolean> {
  const params = new QueryParams();
  const where = `project_id = ${params.add(scope.projectId, "UUID")}
       AND timestamp >= ${params.time(scope.from)} AND timestamp < ${params.time(scope.to)}
       AND service = ${params.add(scope.service, "String")}`;
  const services = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM spans
     PREWHERE ${where}
     WHERE environment = ${params.add(scope.environment, "String")} AND kind = 'server'
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  if (services.length === 0 || scope.route === undefined || scope.route === null) {
    return services.length > 0;
  }
  const routeParams = new QueryParams();
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM spans
     PREWHERE project_id = ${routeParams.add(scope.projectId, "UUID")}
       AND timestamp >= ${routeParams.time(scope.from)} AND timestamp < ${routeParams.time(scope.to)}
       AND service = ${routeParams.add(scope.service, "String")}
     WHERE environment = ${routeParams.add(scope.environment, "String")} AND kind = 'server'
       AND ${ROUTE} = ${routeParams.add(scope.route, "String")}
     LIMIT 1`,
    routeParams,
    DASHBOARD_SETTINGS,
  );
  return rows.length > 0;
}

/** Routes a project's services had in a period: what the alert form suggests. */
export const MAX_RECENT_ROUTES = 200;

/**
 * Up to MAX_RECENT_ROUTES distinct (service, route) pairs of the server
 * spans in [from, to) and one environment, for the alert form's
 * suggestions: DISTINCT with a LIMIT stops reading once it has them, so a
 * busy day costs a little of its spans, not the Services page's counts.
 */
export async function recentRoutes(
  reader: Reader,
  scope: { projectId: string; environment: string; from: Date; to: Date },
): Promise<{ routes: RouteTarget[]; truncated: boolean }> {
  const params = new QueryParams();
  const rows = await queryRows<{ service: string; route: string }>(
    reader,
    `SELECT DISTINCT service, ${ROUTE} AS route
     FROM spans
     PREWHERE project_id = ${params.add(scope.projectId, "UUID")}
       AND timestamp >= ${params.time(scope.from)} AND timestamp < ${params.time(scope.to)}
     WHERE environment = ${params.add(scope.environment, "String")} AND kind = 'server'
       AND route != ''
     LIMIT ${MAX_RECENT_ROUTES + 1}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return {
    routes: rows
      .slice(0, MAX_RECENT_ROUTES)
      .map((row) => ({ service: row.service, route: row.route }))
      .toSorted((a, b) => a.service.localeCompare(b.service) || a.route.localeCompare(b.route)),
    truncated: rows.length > MAX_RECENT_ROUTES,
  };
}

export async function listServices(
  reader: Reader,
  range: TelemetryRange,
  { final = SERVICES_FINAL }: { final?: boolean } = {},
): Promise<{
  services: ServiceSummary[];
  /** More than MAX_SERVICES services: the list holds the first by name. */
  truncated: boolean;
  environments: string[];
  /** Whether the project has sent any span at all. */
  received: boolean;
}> {
  const spans = (params: QueryParams) => serverSpans(params, range, { final });
  // First counts alone, by a hash of each route rather than its name, so
  // a service with a million span names costs a million small groups:
  // each service once (grouping by service alone), then each of its
  // routes; LIMIT BY keeps the service's row and its busiest routes. `uniq`
  // counts a service's routes (exactly up to 65,536, then approximately).
  const countParams = new QueryParams();
  const [rows, labels] = await Promise.all([
    queryRows<CountRow>(
      reader,
      `SELECT service, toString(route_hash) AS route_id, grouping(route_hash) AS whole,
              count() AS requests, countIf(status_code = 'error') AS failed,
              ${STATUS_COLUMNS},
              uniq(route_hash) AS routes
       FROM (SELECT service, cityHash64(service, route) AS route_hash, status_code, status_class
             FROM (${spans(countParams)}))
       GROUP BY GROUPING SETS ((service), (service, route_hash))
       ORDER BY service, whole DESC, requests DESC, route_hash
       LIMIT ${MAX_ROUTES + 1} BY service
       LIMIT ${(MAX_SERVICES + 1) * (MAX_ROUTES + 1)}`,
      countParams,
      DASHBOARD_SETTINGS,
    ),
    labelsInRange(reader, "spans", range, "AND kind = 'server'"),
  ]);
  // Then the names and durations, exactly, of each service and of the
  // routes listed only: every other route's spans share one group per
  // service, so the groups are a few hundred however many routes there are.
  const listed = rows.filter((row) => row.whole !== "1").map((row) => row.route_id);
  const durationParams = new QueryParams();
  const durations =
    rows.length === 0
      ? []
      : await queryRows<DurationRow>(
          reader,
          `SELECT service, listed AS route_id, any(route) AS route,
                  quantilesExactInclusive(0.5, 0.95, 0.99)(duration_ns) AS durations
           FROM (
             SELECT service, route, duration_ns,
                    toString(cityHash64(service, route)) AS id,
                    if(id IN ${durationParams.add(listed, "Array(String)")}, id, NULL) AS listed
             FROM (${spans(durationParams)})
           )
           GROUP BY GROUPING SETS ((service), (service, listed))
           HAVING grouping(listed) = 1 OR listed IS NOT NULL
           LIMIT ${(MAX_SERVICES + 1) * (MAX_ROUTES + 1) * 2}`,
          durationParams,
          DASHBOARD_SETTINGS,
        );
  const durationOf = new Map(
    durations.map((row) => [JSON.stringify([row.service, row.route_id]), row]),
  );
  const stats = (row: CountRow, routeId: string | null): RouteStats => {
    const [p50 = 0, p95 = 0, p99 = 0] =
      durationOf.get(JSON.stringify([row.service, routeId]))?.durations ?? [];
    return {
      requests: Number(row.requests),
      failed: Number(row.failed),
      // Nanoseconds, interpolated, so not whole: microseconds as the other pages give durations.
      p50Us: p50 / 1000,
      p95Us: p95 / 1000,
      p99Us: p99 / 1000,
      statuses: statusesOf(row),
    };
  };
  const services: ServiceSummary[] = [];
  for (const row of rows) {
    const whole = row.whole === "1";
    if (whole) {
      services.push({
        service: row.service,
        ...stats(row, null),
        routeCount: Number(row.routes),
        routes: [],
      });
      continue;
    }
    const current = services.at(-1);
    if (current?.service === row.service)
      current.routes.push({
        route: durationOf.get(JSON.stringify([row.service, row.route_id]))?.route ?? "",
        ...stats(row, row.route_id),
      });
  }
  return {
    services: services.slice(0, MAX_SERVICES).toSorted((a, b) => b.requests - a.requests),
    truncated: services.length > MAX_SERVICES,
    environments: labels.environments,
    received: services.length > 0 || (await hasAnyRow(reader, "spans", range.projectId)),
  };
}

/** A service's or route's requests over the range, in time buckets (bucketsOf, as a metric's chart). */
export interface ServiceChart {
  service: string;
  /** null: every route of the service. */
  route: string | null;
  /** The first bucket's start. */
  start: Date;
  stepSeconds: number;
  buckets: number;
  /** The whole range, counted as the Services page counts it: the buckets add up to these. */
  totals: RouteStats;
  /** Per bucket: the requests, the failed ones, and the requests of each status class. */
  counts: { requests: number[]; failed: number[]; statuses: Record<StatusClass, number[]> };
  /** Each class's requests per second, over the bucket's seconds within the range and before now. */
  perSecond: Record<StatusClass, (number | null)[]>;
  /** The failed share, 0 to 1; null without a request. */
  failedShare: (number | null)[];
  /** The percentiles of the bucket's durations, in microseconds; null without a request. */
  durations: { p50Us: (number | null)[]; p95Us: (number | null)[]; p99Us: (number | null)[] };
}

interface ChartRow extends StatusRow {
  /** "1" for the row of the whole range. */
  whole: string | number;
  bucket: string | number;
  requests: string;
  failed: string;
  durations: number[];
}

const EMPTY_STATUSES: StatusCounts = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, none: 0 };

/**
 * One service's requests, or one of its routes', over the range, in the
 * buckets a metric's chart would have (bucketsOf), and over the whole
 * range, in one read: GROUPING SETS ((), (bucket)), each with the same
 * counts and exact percentiles as the Services page. A span later than the
 * last bucket (a clock ahead, or past the 300 buckets) counts in the last,
 * so the buckets add up to the totals, and the totals are the Services
 * page's for the same range.
 */
export async function serviceChart(
  reader: Reader,
  range: TelemetryRange,
  target: RouteTarget,
  now: Date,
  { final = SERVICES_FINAL }: { final?: boolean } = {},
): Promise<ServiceChart> {
  const buckets = bucketsOf(range, now);
  const params = new QueryParams();
  const rows =
    buckets.count === 0
      ? []
      : await queryRows<ChartRow>(
          reader,
          `SELECT grouping(bucket) AS whole, bucket,
                  count() AS requests, countIf(status_code = 'error') AS failed,
                  ${STATUS_COLUMNS},
                  quantilesExactInclusive(0.5, 0.95, 0.99)(duration_ns) AS durations
           FROM (
             SELECT least(intDiv(toUnixTimestamp64Milli(timestamp) - ${params.add(buckets.firstMs, "Int64")},
                                 ${params.add(buckets.stepMs, "Int64")}),
                          ${params.add(buckets.count - 1, "Int64")}) AS bucket,
                    status_code, status_class, duration_ns
             FROM (${serverSpans(
               params,
               { ...range, service: target.service, route: target.route },
               { final },
             )})
           )
           GROUP BY GROUPING SETS ((), (bucket))
           ORDER BY whole DESC, bucket
           LIMIT ${buckets.count + 1}`,
          params,
          DASHBOARD_SETTINGS,
        );
  const blank = <T>(fill: T) => Array.from({ length: buckets.count }, () => fill);
  const counts: ServiceChart["counts"] = {
    requests: blank(0),
    failed: blank(0),
    statuses: {
      "2xx": blank(0),
      "3xx": blank(0),
      "4xx": blank(0),
      "5xx": blank(0),
      none: blank(0),
    },
  };
  const durations: ServiceChart["durations"] = {
    p50Us: blank(null),
    p95Us: blank(null),
    p99Us: blank(null),
  };
  let totals: RouteStats = {
    requests: 0,
    failed: 0,
    p50Us: 0,
    p95Us: 0,
    p99Us: 0,
    statuses: { ...EMPTY_STATUSES },
  };
  for (const row of rows) {
    const requests = Number(row.requests);
    const [p50 = 0, p95 = 0, p99 = 0] = row.durations;
    if (String(row.whole) === "1") {
      // The whole range: an empty read still has this row, with no request.
      totals = {
        requests,
        failed: Number(row.failed),
        p50Us: requests === 0 ? 0 : p50 / 1000,
        p95Us: requests === 0 ? 0 : p95 / 1000,
        p99Us: requests === 0 ? 0 : p99 / 1000,
        statuses: statusesOf(row),
      };
      continue;
    }
    const index = Number(row.bucket);
    if (index < 0 || index >= buckets.count) continue;
    counts.requests[index] = requests;
    counts.failed[index] = Number(row.failed);
    const statuses = statusesOf(row);
    for (const name of STATUS_CLASSES) counts.statuses[name][index] = statuses[name];
    durations.p50Us[index] = p50 / 1000;
    durations.p95Us[index] = p95 / 1000;
    durations.p99Us[index] = p99 / 1000;
  }
  const seconds = Array.from({ length: buckets.count }, (_, index) =>
    bucketSeconds(buckets, index),
  );
  const rate = (values: number[]) =>
    values.map((value, index) => {
      const length = seconds[index] ?? 0;
      return length > 0 ? value / length : null;
    });
  return {
    service: target.service,
    route: target.route,
    start: new Date(buckets.firstMs),
    stepSeconds: buckets.stepMs / 1000,
    buckets: buckets.count,
    totals,
    counts,
    perSecond: {
      "2xx": rate(counts.statuses["2xx"]),
      "3xx": rate(counts.statuses["3xx"]),
      "4xx": rate(counts.statuses["4xx"]),
      "5xx": rate(counts.statuses["5xx"]),
      none: rate(counts.statuses.none),
    },
    failedShare: counts.requests.map((requests, index) =>
      requests === 0 ? null : (counts.failed[index] ?? 0) / requests,
    ),
    durations,
  };
}
