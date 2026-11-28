import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { canUse, FORBIDDEN, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import { EVENT_NAME_SCHEMA } from "../collection/routes.ts";
import type { Database } from "../db/schema.ts";
import { listGoals } from "../goals/goals.ts";
import { stepOf } from "../product/steps.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  type Analytics,
  LIST_REPORTS,
  type ListReport,
  type PageGoal,
  projectAnalytics,
  projectList,
} from "./analytics.ts";
import { FILTER_NAMES, type FilterName, MAX_LIMIT, type ReportFilter } from "./reports.ts";

/** Bound query work per request. */
export const MAX_RANGE_DAYS = 366;

/** Periods end today in the instance timezone, which the browser does not know. */
export const PERIODS = ["today", "7d", "30d", "90d", "12m"] as const;
export type Period = (typeof PERIODS)[number];

function shiftDay(
  day: string,
  { days = 0, months = 0 }: { days?: number; months?: number },
): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, date + days)).toISOString().slice(0, 10);
}

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

/** PostgreSQL text cannot store NUL. */
const NO_NUL = "^[^\\u0000]*$";

/** Match the longest stored path; compare values without parsing. */
const MAX_FILTER_LENGTH = 2048;

/** One query parameter per filter. An empty value matches visits where it is unknown. */
const FILTER_PROPERTIES = Object.fromEntries(
  FILTER_NAMES.map((name) => [
    name,
    // PostgreSQL cannot store NUL, so it can never match.
    { type: "string", maxLength: MAX_FILTER_LENGTH, pattern: NO_NUL },
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

function requestFilters(query: Partial<Record<FilterName, string>>): ReportFilter[] {
  return FILTER_NAMES.flatMap((name) => {
    const value = query[name];
    return value === undefined ? [] : [{ name, value: value === "" ? null : value }];
  });
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
export type AnalyticsQuery = Omit<RangeQuery, "environment"> & {
  limit?: number;
} & GoalQuery &
  Partial<Record<FilterName, string>>;

/** One full list's query, without the environment. */
export type ListQuery = Omit<RangeQuery, "environment"> & {
  report: ListReport;
  search?: string;
  offset?: number;
  limit?: number;
} & GoalQuery &
  Partial<Record<FilterName, string>>;

const { environment: _environment, ...DAY_PROPERTIES } = RANGE_PROPERTIES;

const ANALYTICS_PROPERTIES = {
  ...DAY_PROPERTIES,
  limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
  ...GOAL_PROPERTIES,
  ...FILTER_PROPERTIES,
};

const LIST_PROPERTIES = {
  ...DAY_PROPERTIES,
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
 * timezone, the filters, and the goal. Without saved goals, the answer's
 * list of goals is empty.
 */
export async function analyticsAnswer(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  scope: ReportScope,
  query: AnalyticsQuery,
  { now, reader }: { now: Date; reader: Reader },
): Promise<{ report: Analytics } | Refusal> {
  // One reading of the clock: the period's days and the comparison's cut-off agree.
  const days = requestDays(query, dayIn(scope.timeZone)(now));
  if ("problem" in days) return { status: 400, body: days.problem };
  const goal = await requestGoal(db, scope, query);
  if ("status" in goal) return goal;
  const { limit } = query;
  const report = await projectAnalytics(db, clickhouse, {
    projectId: scope.projectId,
    environment: scope.environment,
    firstDay: days.from,
    lastDay: days.to,
    timeZone: scope.timeZone,
    filters: requestFilters(query),
    goal: goal.goal,
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
  { now, reader }: { now: Date; reader: Reader },
): Promise<{ list: Awaited<ReturnType<typeof projectList>> } | Refusal> {
  const days = requestDays(query, dayIn(scope.timeZone)(now));
  if ("problem" in days) return { status: 400, body: days.problem };
  const goal = await requestGoal(db, scope, query);
  if ("status" in goal) return goal;
  const { report, search, offset = 0, limit = LIST_PAGE_SIZE } = query;
  const list = await projectList(db, clickhouse, {
    projectId: scope.projectId,
    environment: scope.environment,
    firstDay: days.from,
    lastDay: days.to,
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
