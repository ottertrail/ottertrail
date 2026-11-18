import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  DASHBOARD_SETTINGS,
  hasAnyRow,
  labelsInRange,
  type TelemetryRange,
} from "./dashboard-query.ts";

/**
 * The dashboard's Services page (docs/telemetry.md, "The dashboard"): for
 * each service, and each route of its server spans, the requests in the
 * range, the share that failed, and the median and 95th-percentile duration.
 *
 * A request is a span of kind SERVER. Its route is its `http.route`
 * attribute, else its name. Spans are read FINAL, so a retried span counts
 * once in the requests and the percentiles.
 */

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
}

export interface ServiceSummary extends RouteStats {
  service: string;
  /** All its routes in the range: more than `routes` holds when it was cut. */
  routeCount: number;
  routes: (RouteStats & { route: string })[];
}

interface CountRow {
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

export async function listServices(
  reader: Reader,
  range: TelemetryRange,
): Promise<{
  services: ServiceSummary[];
  /** More than MAX_SERVICES services: the list holds the first by name. */
  truncated: boolean;
  environments: string[];
  /** Whether the project has sent any span at all. */
  received: boolean;
}> {
  const spans = (params: QueryParams) => `
    SELECT service,
           if(attributes['http.route'] != '', attributes['http.route'], name) AS route,
           status_code, duration_ns
    FROM spans FINAL
    WHERE project_id = ${params.add(range.projectId, "UUID")}
      AND timestamp >= ${params.time(range.from)} AND timestamp < ${params.time(range.to)}
      AND environment = ${params.add(range.environment, "String")}
      AND kind = 'server'`;
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
              uniq(route_hash) AS routes
       FROM (SELECT service, cityHash64(service, route) AS route_hash, status_code
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
                  quantilesExactInclusive(0.5, 0.95)(duration_ns) AS durations
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
    const [p50 = 0, p95 = 0] =
      durationOf.get(JSON.stringify([row.service, routeId]))?.durations ?? [];
    return {
      requests: Number(row.requests),
      failed: Number(row.failed),
      // Nanoseconds, interpolated, so not whole: microseconds as the other pages give durations.
      p50Us: p50 / 1000,
      p95Us: p95 / 1000,
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
