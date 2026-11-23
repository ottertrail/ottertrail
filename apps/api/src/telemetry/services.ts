import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  DASHBOARD_SETTINGS,
  hasAnyRow,
  labelsInRange,
  type TelemetryRange,
} from "./dashboard-query.ts";
import { bucketSeconds, bucketsOf } from "./metrics.ts";

/**
 * Requests are SERVER spans; routes use http.route or span name (docs/telemetry.md, "How services
 * are counted"). Lists and charts omit FINAL (SERVICES_FINAL), so retries count until daily
 * merges, forced within about an hour of the day's last insert (FORCE_MERGE_SECONDS, migration
 * 0002 in clickhouse/migrations.ts).
 */

/**
 * FINAL exceeded the 300 MB query limit on busy unmerged parts (docs/telemetry.md, "How services
 * are counted").
 */
export const SERVICES_FINAL = false;

/** "none" covers absent status codes and codes outside 200 to 599. */
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "none"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];
export type StatusCounts = Record<StatusClass, number>;

const STATUS_CODE =
  "if(attributes['http.response.status_code'] != '', attributes['http.response.status_code'], attributes['http.status_code'])";
/** 0 means absent, nonnumeric, or outside 200 to 599. */
const STATUS_DIGIT = `transform(intDiv(toUInt32OrZero(${STATUS_CODE}), 100), [2, 3, 4, 5], [2, 3, 4, 5], 0)`;

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

/** Keeps the busiest routes; routeCount includes omitted routes. */
export const MAX_ROUTES = 100;
/** Keeps the first services by name; reports truncation. */
export const MAX_SERVICES = 200;

export interface RouteStats {
  requests: number;
  failed: number;
  /** Interpolates neighboring durations (quantileExactInclusive), as Speed's p75 does. */
  p50Us: number;
  p95Us: number;
  p99Us: number;
  /** Counts sum to requests. */
  statuses: StatusCounts;
}

export interface ServiceSummary extends RouteStats {
  service: string;
  /** Includes routes omitted by the cap. */
  routeCount: number;
  routes: (RouteStats & { route: string })[];
}

interface CountRow extends StatusRow {
  service: string;
  /** Hash avoids grouping by long route names; the second query resolves names and durations. */
  route_id: string;
  /** "1" marks the service total (UInt64 as text). */
  whole: string;
  requests: string;
  failed: string;
  routes: string;
}

interface DurationRow {
  service: string;
  /** Null for the service total; IDs only for listed routes. */
  route_id: string | null;
  route: string;
  durations: number[];
}

export const ROUTE = "if(attributes['http.route'] != '', attributes['http.route'], name)";

export interface SpanScope {
  projectId: string;
  environment: string;
  from: Date;
  to: Date;
  service?: string | undefined;
  /** Null or undefined selects all routes. */
  route?: string | null | undefined;
}

/**
 * PREWHERE reads project, time, and service before attributes needed for route and status.
 * Deduplicates only with `final`.
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

export interface WindowStats {
  requests: number;
  failed: number;
  /** Null without requests; interpolated as in Services. */
  p95Us: number | null;
  p99Us: number | null;
}

export interface RouteTarget {
  service: string;
  route: string | null;
}

/** Each target's window ends at the read cutoff. */
export interface WindowTarget extends RouteTarget {
  from: Date;
}

/**
 * Reads all target windows together using -If combinators. PREWHERE filters services before
 * attributes, and attributes are needed only for route targets. Without FINAL, retries count until
 * daily merges (forced within about an hour of the day's last insert, migration 0002). This barely
 * affects shares or percentiles and avoids costly merges (docs/uptime-alerts.md, step 4).
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
  // Aliases use indices, never input.
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

/** Checks narrow service columns first, then reads attributes only for route targets. */
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

export const MAX_RECENT_ROUTES = 200;

/**
 * DISTINCT with LIMIT stops after MAX_RECENT_ROUTES suggestions, avoiding a full Services-page
 * aggregation.
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
  /** Keeps the first MAX_SERVICES by name. */
  truncated: boolean;
  environments: string[];
  received: boolean;
}> {
  const spans = (params: QueryParams) => serverSpans(params, range, { final });
  // Hash route names to bound group size. LIMIT BY keeps service totals and busiest routes. uniq
  // is exact through 65,536 routes, then approximate.
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
  // Resolve names and exact durations only for listed routes. Group all other routes together per
  // service to bound aggregate memory.
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
      // Interpolated nanoseconds may be fractional; convert to microseconds.
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

export interface ServiceChart {
  service: string;
  /** Null selects all routes. */
  route: string | null;
  start: Date;
  stepSeconds: number;
  buckets: number;
  /** Buckets sum to these totals, matching the Services list. */
  totals: RouteStats;
  counts: { requests: number[]; failed: number[]; statuses: Record<StatusClass, number[]> };
  /** Uses bucket seconds within the range and before now. */
  perSecond: Record<StatusClass, (number | null)[]>;
  /** 0 to 1; null without requests. */
  failedShare: (number | null)[];
  /** Microseconds; null without requests. */
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
 * GROUPING SETS reads buckets and totals together. Late spans join the last bucket so sums match
 * the Services list, including spans past the 300-bucket cap.
 */
export async function serviceChart(
  reader: Reader,
  range: TelemetryRange,
  target: RouteTarget,
  now: Date,
  { final = SERVICES_FINAL }: { final?: boolean } = {},
): Promise<ServiceChart> {
  return {
    service: target.service,
    route: target.route,
    ...(await requestChart(reader, range, target, now, final)),
  };
}

export type ServicesTrend = Omit<ServiceChart, "service" | "route">;

/**
 * Uses the same buckets and counting rules as Services, including unmerged retries
 * (SERVICES_FINAL), so chart and list totals agree.
 */
export async function servicesTrend(
  reader: Reader,
  range: TelemetryRange,
  now: Date,
  { final = SERVICES_FINAL }: { final?: boolean } = {},
): Promise<ServicesTrend> {
  return requestChart(reader, range, null, now, final);
}

async function requestChart(
  reader: Reader,
  range: TelemetryRange,
  target: RouteTarget | null,
  now: Date,
  final: boolean,
): Promise<ServicesTrend> {
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
               target === null ? range : { ...range, service: target.service, route: target.route },
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
      // The total row exists even when the read is empty.
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

const durationOf = (requests: number, ns: number) => (requests === 0 ? null : ns / 1000);

/** Keeps the busiest services. */
export const OVERVIEW_SERVICES = 5;

export interface ServiceTotals {
  service: string;
  requests: number;
  failed: number;
  /** Null without requests; interpolated as in Services. */
  p95Us: number | null;
  previous: { requests: number; failed: number; p95Us: number | null };
}

/**
 * Reads current and previous periods together, without FINAL. Omits routes to avoid reading
 * attributes. Keeps the busiest OVERVIEW_SERVICES; `more` reports others.
 */
export async function serviceTotals(
  reader: Reader,
  scope: {
    projectId: string;
    environment: string;
    from: Date;
    to: Date;
    previousFrom: Date;
    previousTo: Date;
  },
): Promise<{ services: ServiceTotals[]; more: boolean }> {
  const params = new QueryParams();
  const from = params.time(scope.from);
  const previousTo = params.time(scope.previousTo);
  const rows = await queryRows<{
    service: string;
    requests: string;
    failed: string;
    p95: number;
    previous_requests: string;
    previous_failed: string;
    previous_p95: number;
  }>(
    reader,
    `SELECT service,
            countIf(current) AS requests,
            countIf(current AND status_code = 'error') AS failed,
            quantileExactInclusiveIf(0.95)(duration_ns, current) AS p95,
            countIf(NOT current) AS previous_requests,
            countIf(NOT current AND status_code = 'error') AS previous_failed,
            quantileExactInclusiveIf(0.95)(duration_ns, NOT current) AS previous_p95
     FROM (
       SELECT service, status_code, duration_ns, timestamp >= ${from} AS current
       FROM spans
       PREWHERE project_id = ${params.add(scope.projectId, "UUID")}
         AND timestamp >= ${params.time(scope.previousFrom)}
         AND timestamp < ${params.time(scope.to)}
       WHERE environment = ${params.add(scope.environment, "String")}
         AND kind = 'server'
         AND (timestamp >= ${from} OR timestamp < ${previousTo})
     )
     GROUP BY service
     HAVING requests > 0
     ORDER BY requests DESC, service
     LIMIT ${OVERVIEW_SERVICES + 1}`,
    params,
    DASHBOARD_SETTINGS,
  );
  return {
    services: rows.slice(0, OVERVIEW_SERVICES).map((row) => {
      const requests = Number(row.requests);
      const previousRequests = Number(row.previous_requests);
      return {
        service: row.service,
        requests,
        failed: Number(row.failed),
        p95Us: durationOf(requests, row.p95),
        previous: {
          requests: previousRequests,
          failed: Number(row.previous_failed),
          p95Us: durationOf(previousRequests, row.previous_p95),
        },
      };
    }),
    more: rows.length > OVERVIEW_SERVICES,
  };
}
