import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { type ProjectAccess, requireProjectAccess } from "../organizations/access.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { LIST_REPORTS, type ListReport, projectAnalytics, projectList } from "./analytics.ts";
import { FILTER_NAMES, type FilterName, MAX_LIMIT, type ReportFilter } from "./reports.ts";

/** The longest range one request may cover, to bound the work it causes. */
export const MAX_RANGE_DAYS = 366;

/** Ranges that end today in the organization's timezone, which the browser does not know. */
export const PERIODS = ["today", "7d", "30d", "90d", "12m"] as const;
export type Period = (typeof PERIODS)[number];

/** "YYYY-MM-DD" moved by whole days and months on the calendar. */
function shiftDay(
  day: string,
  { days = 0, months = 0 }: { days?: number; months?: number },
): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, date + days)).toISOString().slice(0, 10);
}

/** Days before today that each fixed-length period starts. */
const DAYS_BACK: Record<Exclude<Period, "12m">, number> = {
  today: 0,
  "7d": 6,
  "30d": 29,
  "90d": 89,
};

/** The first and last day of a period that ends on `today`, both included. */
export function periodDays(period: Period, today: string): { from: string; to: string } {
  const from =
    period === "12m"
      ? // From the day after the same date last year: 365 or 366 days.
        shiftDay(shiftDay(today, { months: -12 }), { days: 1 })
      : shiftDay(today, { days: -DAYS_BACK[period] });
  return { from, to: today };
}

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/** Milliseconds since 1970 for a "YYYY-MM-DD" that names a real calendar day, or null. */
function dayNumber(day: string): number | null {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== day ? null : time;
}

function problem(code: string, message: string) {
  return { error: code, message };
}

/** As text a query parameter may hold: no NUL, which PostgreSQL text cannot hold. */
const NO_NUL = "^[^\\u0000]*$";

/** As long as the longest stored path; values are compared, never parsed. */
const MAX_FILTER_LENGTH = 2048;

/** One query parameter per filter. An empty value matches visits where it is unknown. */
const FILTER_PROPERTIES = Object.fromEntries(
  FILTER_NAMES.map((name) => [
    name,
    // No NUL: PostgreSQL text cannot hold it, so it could never match.
    { type: "string", maxLength: MAX_FILTER_LENGTH, pattern: NO_NUL },
  ]),
);

/** Rows one page of a "show all" list holds. */
export const LIST_PAGE_SIZE = 50;
/** Search text a list accepts: far longer than any name worth typing. */
const MAX_SEARCH_LENGTH = 200;

/**
 * Refuses query parameters the route does not know. Fastify's validator
 * drops them silently, so a mistyped filter ("contry") would return
 * unfiltered numbers. Runs before validation, while the query still holds
 * every parameter sent.
 */
function refuseUnknownParameters(names: readonly string[]) {
  const known = new Set(names);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { query } = request;
    const sent = typeof query === "object" && query !== null ? Object.keys(query) : [];
    const unknown = sent.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      return reply
        .code(400)
        .send(problem("invalid_query", `Unknown query parameter: ${unknown.join(", ")}.`));
    }
    // Nothing sent: Fastify goes on to validation.
    return undefined;
  };
}

export interface RangeQuery {
  from?: string;
  to?: string;
  period?: Period;
  /** The environment to count, any case; "production" when left out. */
  environment?: string;
}

export const RANGE_PROPERTIES = {
  from: { type: "string", pattern: DAY_PATTERN },
  to: { type: "string", pattern: DAY_PATTERN },
  period: { type: "string", enum: PERIODS },
  environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
};

const PARAMS_SCHEMA = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

/** The days a request asks for, or the reason it cannot be answered. */
export function requestDays(
  query: RangeQuery,
  todayDay: string,
): { from: string; to: string } | { problem: ReturnType<typeof problem> } {
  const { period } = query;
  if (period !== undefined && (query.from !== undefined || query.to !== undefined)) {
    return { problem: problem("invalid_range", "Send either period, or from and to, not both.") };
  }
  const days =
    period === undefined ? { from: query.from, to: query.to } : periodDays(period, todayDay);
  if (days.from === undefined || days.to === undefined) {
    return { problem: problem("invalid_range", "Send period, or both from and to.") };
  }
  const first = dayNumber(days.from);
  const last = dayNumber(days.to);
  if (first === null || last === null) {
    return { problem: problem("invalid_range", "from and to must be real calendar days.") };
  }
  if (last < first) {
    return { problem: problem("invalid_range", "to must not be before from.") };
  }
  if ((last - first) / 86_400_000 + 1 > MAX_RANGE_DAYS) {
    return { problem: problem("invalid_range", `A range covers at most ${MAX_RANGE_DAYS} days.`) };
  }
  return { from: days.from, to: days.to };
}

function requestFilters(query: Partial<Record<FilterName, string>>): ReportFilter[] {
  return FILTER_NAMES.flatMap((name) => {
    const value = query[name];
    return value === undefined ? [] : [{ name, value: value === "" ? null : value }];
  });
}

/** The access requireProjectAccess set: the report routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * GET /api/projects/:id/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD[&limit=10]
 * GET /api/projects/:id/analytics?period=7d[&environment=staging][&limit=10][&country=DE&page=/pricing …]
 *
 * Every report of the analytics page for whole days in the timezone of the
 * project's organization, from and to included (see analytics.ts), in one
 * environment ("production" unless named). A period (today, 7d, 30d, 90d,
 * 12m) ends today in that timezone. Filters (FILTER_NAMES) narrow every
 * report to the visits that match all of them.
 * Like every project route, both run requireProjectAccess first.
 */
export const reportRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  /** Where the events are; PostgreSQL holds the projects and counts the days. */
  clickhouse: ClickHouseClient;
  auth: Auth;
  now?: () => Date;
}> = (app, { db, clickhouse, auth, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const projectAccess = requireProjectAccess(db);

  // For these routes only (clickhouse/route-errors.ts).
  app.setErrorHandler(clickHouseErrorHandler);
  app.get<{
    Params: { id: string };
    Querystring: RangeQuery & { limit?: number } & Partial<Record<FilterName, string>>;
  }>(
    "/projects/:id/analytics",
    {
      preHandler: [signedIn, projectAccess],
      preValidation: refuseUnknownParameters([
        ...Object.keys(RANGE_PROPERTIES),
        "limit",
        ...FILTER_NAMES,
      ]),
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
            ...FILTER_PROPERTIES,
          },
        },
      },
    },
    async (request, reply) => {
      const { timeZone } = accessOf(request);
      // One reading of the clock: the period's days and the comparison's cut-off agree.
      const current = now();
      const days = requestDays(request.query, dayIn(timeZone)(current));
      if ("problem" in days) {
        return reply.code(400).send(days.problem);
      }
      const { limit } = request.query;
      return projectAnalytics(db, clickhouse, {
        projectId: request.params.id,
        environment: environmentOf(request.query.environment),
        firstDay: days.from,
        lastDay: days.to,
        timeZone,
        filters: requestFilters(request.query),
        now: current,
        ...(limit === undefined ? {} : { limit }),
      });
    },
  );

  /**
   * GET /api/projects/:id/analytics/list?report=country&period=7d[&search=…&offset=0&limit=50][&filters …]
   *
   * One list of the analytics page, a page at a time, for "show all": the
   * same days and filters as the page, rows whose name contains `search`
   * (case-insensitive; for countries, the English name), and `hasMore`.
   */
  app.get<{
    Params: { id: string };
    Querystring: RangeQuery & {
      report: ListReport;
      search?: string;
      offset?: number;
      limit?: number;
    } & Partial<Record<FilterName, string>>;
  }>(
    "/projects/:id/analytics/list",
    {
      preHandler: [signedIn, projectAccess],
      preValidation: refuseUnknownParameters([
        ...Object.keys(RANGE_PROPERTIES),
        "report",
        "search",
        "offset",
        "limit",
        ...FILTER_NAMES,
      ]),
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["report"],
          properties: {
            ...RANGE_PROPERTIES,
            report: { type: "string", enum: LIST_REPORTS },
            search: { type: "string", maxLength: MAX_SEARCH_LENGTH, pattern: NO_NUL },
            offset: { type: "integer", minimum: 0, maximum: 100_000 },
            limit: { type: "integer", minimum: 1, maximum: LIST_PAGE_SIZE },
            ...FILTER_PROPERTIES,
          },
        },
      },
    },
    async (request, reply) => {
      const { timeZone } = accessOf(request);
      const days = requestDays(request.query, dayIn(timeZone)(now()));
      if ("problem" in days) {
        return reply.code(400).send(days.problem);
      }
      const { report, search, offset = 0, limit = LIST_PAGE_SIZE } = request.query;
      return projectList(db, clickhouse, {
        projectId: request.params.id,
        environment: environmentOf(request.query.environment),
        firstDay: days.from,
        lastDay: days.to,
        timeZone,
        filters: requestFilters(request.query),
        report,
        limit,
        offset,
        ...(search === undefined ? {} : { search }),
      });
    },
  );
  done();
};
