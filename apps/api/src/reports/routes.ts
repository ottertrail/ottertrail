import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { canUse, FORBIDDEN, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import { EVENT_NAME_SCHEMA } from "../collection/routes.ts";
import type { Database } from "../db/schema.ts";
import { listGoals } from "../goals/goals.ts";
import { stepOf } from "../product/steps.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { analyticsEvent } from "../visits/visits.ts";
import {
  type Analytics,
  COMPARISONS,
  type Comparison,
  LIST_REPORTS,
  type ListReport,
  type PageGoal,
  projectAnalytics,
  projectList,
} from "./analytics.ts";
import { CHART_INTERVALS, type ChartInterval } from "./chart.ts";
import {
  FILTER_NAMES,
  type FilterName,
  type FilterOperator,
  MAX_LIMIT,
  operatorsOf,
  type ReportFilter,
} from "./reports.ts";

/** Bound query work per request. */
export const MAX_RANGE_DAYS = 366;

/**
 * The periods every report page shares, in the instance timezone, which the
 * browser does not know. Each is whole days; all but yesterday end today.
 */
export const PERIODS = ["today", "yesterday", "7d", "30d", "mtd", "90d", "ytd", "12m"] as const;
export type Period = (typeof PERIODS)[number];

function shiftDay(
  day: string,
  { days = 0, months = 0 }: { days?: number; months?: number },
): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, date + days)).toISOString().slice(0, 10);
}

const DAYS_BACK: Record<"today" | "7d" | "30d" | "90d", number> = {
  today: 0,
  "7d": 6,
  "30d": 29,
  "90d": 89,
};

/** The first and last day of a period, as of `today`, both included. */
export function periodDays(period: Period, today: string): { from: string; to: string } {
  switch (period) {
    case "yesterday": {
      const yesterday = shiftDay(today, { days: -1 });
      return { from: yesterday, to: yesterday };
    }
    case "mtd":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "ytd":
      return { from: `${today.slice(0, 5)}01-01`, to: today };
    case "12m":
      // From the day after the same date last year: 365 or 366 days.
      return { from: shiftDay(shiftDay(today, { months: -12 }), { days: 1 }), to: today };
    default:
      return { from: shiftDay(today, { days: -DAYS_BACK[period] }), to: today };
  }
}

/**
 * What a period's "previous period" moves back by (reports.ts,
 * previousDays): month to date and year to date compare with the same days
 * of the month or year before, the others with as many days just before.
 */
export const periodCalendar = (period: string | undefined): "month" | "year" | undefined =>
  period === "mtd" ? "month" : period === "ytd" ? "year" : undefined;

/**
 * Web analytics' periods: the shared ones, and ranges only its page
 * offers (docs/web-analytics.md, "Ranges"). "24h" is a rolling window
 * that ends now; "all" starts on the day of the first event.
 */
export const ANALYTICS_PERIODS = [...PERIODS, "24h", "all"] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

const isPeriod = (period: AnalyticsPeriod): period is Period =>
  PERIODS.some((item) => item === period);

/** All time reads at most ten years back, past the 3,650 days the longest set retention keeps. */
export const MAX_ALL_TIME_DAYS = 3660;
/** All time's whole request, its queries together, ends after this. */
export const ALL_TIME_SECONDS = 30;

/** A Web analytics range: whole days, or a rolling window over parts of two. */
export interface AnalyticsDays {
  from: string;
  to: string;
  window?: { from: Date; to: Date } | undefined;
}

/**
 * The local day of the environment's first event that Web analytics
 * counts, or null without one. The events are sorted by project, then UTC
 * day, so the inner query reads the first day's granules only; the outer
 * one finds the first moment within that day.
 */
async function firstEventDay(reader: Reader, scope: ReportScope): Promise<string | null> {
  const params = new QueryParams();
  const project = params.add(scope.projectId, "UUID");
  const environment = params.add(scope.environment, "String");
  const counted = `project_id = ${project} AND environment = ${environment}
       AND visitor_id IS NOT NULL AND ${analyticsEvent()}`;
  const [row] = await queryRows<{ first: string | null }>(
    reader,
    `SELECT minOrNull(occurred_at) AS first FROM events
     WHERE ${counted}
       AND toDate(occurred_at) = (
         SELECT toDate(occurred_at) FROM events WHERE ${counted}
         ORDER BY project_id, toDate(occurred_at) LIMIT 1
       )`,
    params,
  );
  return row?.first === null || row?.first === undefined
    ? null
    : dayIn(scope.timeZone)(fromClickHouseTime(row.first));
}

/**
 * The days a Web analytics request asks for, from `now` in the scope's
 * timezone. All time reads the first event's day first, with `reader`, so
 * the request's query limit covers it.
 */
export async function analyticsDays(
  reader: Reader,
  scope: ReportScope,
  query: RangeQuery<AnalyticsPeriod>,
  now: Date,
): Promise<AnalyticsDays | { problem: ReturnType<typeof problem> }> {
  const { period } = query;
  if (period === undefined || isPeriod(period)) {
    return requestDays({ ...query, period }, dayIn(scope.timeZone)(now));
  }
  if (query.from !== undefined || query.to !== undefined) {
    return { problem: problem("invalid_range", "Send either period, or from and to, not both.") };
  }
  const day = dayIn(scope.timeZone);
  const today = day(now);
  if (period === "24h") {
    const from = new Date(now.getTime() - 86_400_000);
    return { from: day(from), to: today, window: { from, to: now } };
  }
  const earliest = shiftDay(today, { days: 1 - MAX_ALL_TIME_DAYS });
  const first = (await firstEventDay(reader, scope)) ?? today;
  return { from: first < earliest ? earliest : first > today ? today : first, to: today };
}

/** All time runs within ALL_TIME_SECONDS; a slower page answers 503 and asks for a shorter range. */
const readerFor = (reader: Reader, period: AnalyticsPeriod | undefined): Reader =>
  // The real clock: a test's fixed now must not end the request.
  period === "all" ? { ...reader, deadline: Date.now() + ALL_TIME_SECONDS * 1000 } : reader;

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

/** PostgreSQL text cannot store NUL. */
const NO_NUL = "^[^\\u0000]*$";

/** Match the longest stored path; compare values without parsing. */
export const MAX_FILTER_LENGTH = 2048;

/** A part to look for is typed by a person, so it is shorter. */
export const MAX_CONTAINS_LENGTH = 200;

/** Values one filter matches any of. */
export const MAX_FILTER_VALUES = 10;

/**
 * A filter's query parameter: its name for is, with a suffix for the
 * others: `country=DE&country=FR`, `country.not=DE`, `page.contains=/blog`.
 */
export const OPERATOR_SUFFIXES = {
  is: "",
  isNot: ".not",
  contains: ".contains",
  notContains: ".notContains",
} as const satisfies Record<FilterOperator, string>;

type FilterParameter = `${FilterName}${(typeof OPERATOR_SUFFIXES)[FilterOperator]}`;

/** Each filter's values, one parameter per filter and operator, repeated for several values. */
export type FilterQuery = Partial<Record<FilterParameter, string[]>>;

const isContains = (operator: FilterOperator) =>
  operator === "contains" || operator === "notContains";

const parameterOf = (name: FilterName, operator: FilterOperator): FilterParameter =>
  `${name}${OPERATOR_SUFFIXES[operator]}`;

const FILTER_PARAMETERS = FILTER_NAMES.flatMap((name) =>
  operatorsOf(name).map((operator) => ({ parameter: parameterOf(name, operator), name, operator })),
);

/**
 * A fixed value takes no contains parameter, so one is refused as unknown.
 * An empty value of is or is not matches visits where it is unknown.
 */
const FILTER_PROPERTIES = Object.fromEntries(
  FILTER_PARAMETERS.map(({ parameter, operator }) => [
    parameter,
    {
      // Fastify's validator turns a single value into an array of one.
      type: "array",
      maxItems: MAX_FILTER_VALUES,
      // PostgreSQL cannot store NUL, so it can never match.
      items: isContains(operator)
        ? { type: "string", minLength: 1, maxLength: MAX_CONTAINS_LENGTH, pattern: NO_NUL }
        : { type: "string", maxLength: MAX_FILTER_LENGTH, pattern: NO_NUL },
    },
  ]),
);

export const LIST_PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 200;

/**
 * Reject unknown parameters before Fastify drops them; otherwise a
 * mistyped filter would silently return unfiltered counts.
 */
export function refuseUnknownParameters(names: readonly string[]) {
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
    return undefined;
  };
}

export interface RangeQuery<P extends string = Period> {
  from?: string;
  to?: string;
  period?: P;
  /** The environment to count, any case; "production" when left out. */
  environment?: string;
}

export const RANGE_PROPERTIES = {
  from: { type: "string", pattern: DAY_PATTERN },
  to: { type: "string", pattern: DAY_PATTERN },
  period: { type: "string", enum: PERIODS },
  environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
};

export const PARAMS_SCHEMA = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

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

function requestFilters(query: FilterQuery): ReportFilter[] {
  return FILTER_PARAMETERS.flatMap(({ parameter, name, operator }) => {
    const sent = query[parameter];
    if (sent === undefined || sent.length === 0) return [];
    const values = [...new Set(sent)].map((value) =>
      value === "" && !isContains(operator) ? null : value,
    );
    return [{ name, operator, values }];
  });
}

/**
 * The longest a saved set of filters may be as query text. Half of Node's
 * 16 KB header limit, so the page's request with it, its address, and its
 * cookie still fit.
 */
export const MAX_FILTER_QUERY_LENGTH = 8192;

/** A value the route's schema takes for `operator`; lengths in code points, as the schema counts. */
function isFilterText(operator: FilterOperator, value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\u0000")) return false;
  const length = value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "_").length;
  return isContains(operator)
    ? length >= 1 && length <= MAX_CONTAINS_LENGTH
    : length <= MAX_FILTER_LENGTH;
}

/**
 * Filters held as data, such as a saved segment's: the query's parameters
 * as an object, `{"country.not":["DE"]}`, checked by the rules the routes
 * apply to an address. Null when the address would be refused, when there
 * is no filter, or when the query text is over MAX_FILTER_QUERY_LENGTH. A
 * value given twice counts once.
 */
export function filterQueryOf(value: unknown): FilterQuery | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const sent = new Map<string, unknown>(Object.entries(value));
  if (sent.size === 0) return null;
  const query: FilterQuery = {};
  const text = new URLSearchParams();
  for (const { parameter, operator } of FILTER_PARAMETERS) {
    if (!sent.has(parameter)) continue;
    const values = sent.get(parameter);
    sent.delete(parameter);
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_FILTER_VALUES) {
      return null;
    }
    if (!values.every((item) => isFilterText(operator, item))) return null;
    query[parameter] = [...new Set(values)];
    for (const item of query[parameter]) text.append(parameter, item);
  }
  if (sent.size > 0 || text.toString().length > MAX_FILTER_QUERY_LENGTH) return null;
  return query;
}

/** The goal filter: a saved goal by its ID, or a custom event by its name. */
interface GoalQuery {
  goal?: string;
  goalEvent?: string;
}

const GOAL_PROPERTIES = {
  goal: { type: "string", pattern: UUID_PATTERN },
  goalEvent: EVENT_NAME_SCHEMA,
};

export function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * What a Web analytics report reads: one project, one environment, in the
 * instance's timezone. The dashboard's routes take them from the access
 * check and the request; a shared link's from the link alone
 * (share/routes.ts).
 */
export interface ReportScope {
  projectId: string;
  environment: string;
  timeZone: string;
  /**
   * Whether the project's saved goals are listed and may filter: with
   * product analytics at view (docs/access.md), and on a shared link.
   */
  savedGoals: boolean;
}

type Refusal = { status: 400 | 403; body: ReturnType<typeof problem> };

/**
 * The goal a request filters by, or why it is refused. A saved goal belongs
 * to product analytics, as the Goals table does (docs/access.md); a custom
 * event is on the page already, so it needs nothing more.
 */
async function requestGoal(
  db: Kysely<Database>,
  scope: ReportScope,
  { goal: goalId, goalEvent }: GoalQuery,
): Promise<{ goal: PageGoal | undefined } | Refusal> {
  if (goalId !== undefined && goalEvent !== undefined) {
    return {
      status: 400,
      body: problem("invalid_goal", "Send either goal or goalEvent, not both."),
    };
  }
  if (goalEvent !== undefined) {
    const step = stepOf({ type: "event", name: goalEvent });
    if (step === null) {
      return {
        status: 400,
        body: problem("invalid_goal", "goalEvent names a custom event, not one of the tracker's."),
      };
    }
    return { goal: { id: null, name: goalEvent, step } };
  }
  if (goalId === undefined) return { goal: undefined };
  if (!scope.savedGoals) {
    return { status: 403, body: FORBIDDEN };
  }
  const saved = (await listGoals(db, scope.projectId)).find(
    (item) => item.id.toLowerCase() === goalId.toLowerCase(),
  );
  if (saved === undefined) {
    return {
      status: 400,
      body: problem("unknown_goal", "This goal does not exist. It may have been deleted."),
    };
  }
  return { goal: { id: saved.id, name: saved.name, step: saved.step } };
}

/** The Web analytics page's query, without the environment, which the scope names. */
export type AnalyticsQuery = Omit<RangeQuery<AnalyticsPeriod>, "environment"> & {
  limit?: number;
  /** The chart's interval (chart.ts); the range's default when left out. */
  interval?: ChartInterval;
  /** What the summary and the chart compare with; "previous" when left out. */
  compare?: Comparison;
} & GoalQuery &
  FilterQuery;

/** One full list's query, without the environment. */
export type ListQuery = Omit<RangeQuery<AnalyticsPeriod>, "environment"> & {
  report: ListReport;
  search?: string;
  offset?: number;
  limit?: number;
} & GoalQuery &
  FilterQuery;

const { environment: _environment, ...DAY_PROPERTIES } = RANGE_PROPERTIES;

const ANALYTICS_DAY_PROPERTIES = {
  ...DAY_PROPERTIES,
  period: { type: "string", enum: ANALYTICS_PERIODS },
};

const ANALYTICS_PROPERTIES = {
  ...ANALYTICS_DAY_PROPERTIES,
  limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
  interval: { type: "string", enum: CHART_INTERVALS },
  compare: { type: "string", enum: COMPARISONS },
  ...GOAL_PROPERTIES,
  ...FILTER_PROPERTIES,
};

const LIST_PROPERTIES = {
  ...ANALYTICS_DAY_PROPERTIES,
  report: { type: "string", enum: LIST_REPORTS },
  search: { type: "string", maxLength: MAX_SEARCH_LENGTH, pattern: NO_NUL },
  offset: { type: "integer", minimum: 0, maximum: 100_000 },
  limit: { type: "integer", minimum: 1, maximum: LIST_PAGE_SIZE },
  ...GOAL_PROPERTIES,
  ...FILTER_PROPERTIES,
};

/**
 * The route options' query checks for the page and for a full list: with
 * the environment for the dashboard, and without it where the scope fixes
 * it (a shared link), so a request cannot name another.
 */
export function analyticsQueryChecks({ environment }: { environment: boolean }) {
  const properties = environment
    ? { ...ANALYTICS_PROPERTIES, environment: RANGE_PROPERTIES.environment }
    : ANALYTICS_PROPERTIES;
  return {
    preValidation: refuseUnknownParameters(Object.keys(properties)),
    querystring: { type: "object", additionalProperties: false, properties },
  };
}

export function listQueryChecks({ environment }: { environment: boolean }) {
  const properties = environment
    ? { ...LIST_PROPERTIES, environment: RANGE_PROPERTIES.environment }
    : LIST_PROPERTIES;
  return {
    preValidation: refuseUnknownParameters(Object.keys(properties)),
    querystring: {
      type: "object",
      additionalProperties: false,
      required: ["report"],
      properties,
    },
  };
}

/**
 * The Web analytics page for `scope`: the period's days in the instance's
 * timezone, the filters, the goal, the chart's interval, and the comparison.
 * Without saved goals, the answer's list of goals is empty. All time has no
 * comparison: nothing came before its first day.
 */
export async function analyticsAnswer(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  scope: ReportScope,
  query: AnalyticsQuery,
  { now, reader: base }: { now: Date; reader: Reader },
): Promise<{ report: Analytics } | Refusal> {
  const goal = await requestGoal(db, scope, query);
  if ("status" in goal) return goal;
  const reader = readerFor(base, query.period);
  // One reading of the clock: the period's days and the comparison's cut-off agree.
  const days = await analyticsDays(reader, scope, query, now);
  if ("problem" in days) return { status: 400, body: days.problem };
  const { limit, interval } = query;
  const report = await projectAnalytics(db, clickhouse, {
    projectId: scope.projectId,
    environment: scope.environment,
    firstDay: days.from,
    lastDay: days.to,
    window: days.window,
    timeZone: scope.timeZone,
    filters: requestFilters(query),
    goal: goal.goal,
    interval,
    comparison: query.period === "all" ? "off" : query.compare,
    previousCalendar: periodCalendar(query.period),
    now,
    reader,
    ...(limit === undefined ? {} : { limit }),
  });
  // Goals belong to product analytics (docs/access.md).
  return { report: scope.savedGoals ? report : { ...report, goals: [] } };
}

/**
 * One list in full for `scope`. Match search case-insensitively; country
 * lists search English names. Use the same days, filters, and goal as the
 * analytics page.
 */
export async function listAnswer(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  scope: ReportScope,
  query: ListQuery,
  { now, reader: base }: { now: Date; reader: Reader },
): Promise<{ list: Awaited<ReturnType<typeof projectList>> } | Refusal> {
  const goal = await requestGoal(db, scope, query);
  if ("status" in goal) return goal;
  const reader = readerFor(base, query.period);
  const days = await analyticsDays(reader, scope, query, now);
  if ("problem" in days) return { status: 400, body: days.problem };
  const { report, search, offset = 0, limit = LIST_PAGE_SIZE } = query;
  const list = await projectList(db, clickhouse, {
    projectId: scope.projectId,
    environment: scope.environment,
    firstDay: days.from,
    lastDay: days.to,
    window: days.window,
    timeZone: scope.timeZone,
    filters: requestFilters(query),
    report,
    limit,
    offset,
    goal: goal.goal,
    reader,
    ...(search === undefined ? {} : { search }),
  });
  return { list };
}

/** The scope of a dashboard request, after requireProjectAccess. */
function dashboardScope(request: {
  projectAccess: ProjectAccess | null;
  query: { environment?: string };
}): ReportScope {
  const access = accessOf(request);
  return {
    projectId: access.projectId,
    environment: environmentOf(request.query.environment),
    timeZone: access.timeZone,
    savedGoals: canUse(access.user, "product_analytics", "view"),
  };
}

/**
 * Use inclusive days in the instance timezone (analytics.ts). Default to
 * production. All filters apply to every report; a goal adds conversions.
 * The queries run within the dashboard's query limit.
 */
export const reportRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  /** The dashboard's query limit (telemetry/dashboard-limit.ts). */
  limiter?: DashboardQueryLimiter;
  now?: () => Date;
}> = (
  app,
  { db, clickhouse, auth, limiter = new DashboardQueryLimiter(), now = () => new Date() },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "web_analytics", level: "view" });

  // For these routes only (clickhouse/route-errors.ts).
  app.setErrorHandler(clickHouseErrorHandler);
  const analyticsChecks = analyticsQueryChecks({ environment: true });
  app.get<{
    Params: { id: string };
    Querystring: AnalyticsQuery & Pick<RangeQuery, "environment">;
  }>(
    "/projects/:id/analytics",
    {
      preHandler: [signedIn, canView],
      preValidation: analyticsChecks.preValidation,
      schema: { params: PARAMS_SCHEMA, querystring: analyticsChecks.querystring },
    },
    async (request, reply) => {
      const answer = await analyticsAnswer(db, clickhouse, dashboardScope(request), request.query, {
        now: now(),
        reader: dashboardReader(clickhouse, limiter, reply),
      });
      return "status" in answer ? reply.code(answer.status).send(answer.body) : answer.report;
    },
  );

  const listChecks = listQueryChecks({ environment: true });
  app.get<{ Params: { id: string }; Querystring: ListQuery & Pick<RangeQuery, "environment"> }>(
    "/projects/:id/analytics/list",
    {
      preHandler: [signedIn, canView],
      preValidation: listChecks.preValidation,
      schema: { params: PARAMS_SCHEMA, querystring: listChecks.querystring },
    },
    async (request, reply) => {
      const answer = await listAnswer(db, clickhouse, dashboardScope(request), request.query, {
        now: now(),
        reader: dashboardReader(clickhouse, limiter, reply),
      });
      return "status" in answer ? reply.code(answer.status).send(answer.body) : answer.list;
    },
  );
  done();
};
