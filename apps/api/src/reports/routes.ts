import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { canUse, FORBIDDEN, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import { EVENT_NAME_SCHEMA } from "../collection/routes.ts";
import type { Database } from "../db/schema.ts";
import { listGoals } from "../goals/goals.ts";
import { stepOf } from "../product/steps.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
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

const GOAL_PARAMETERS = ["goal", "goalEvent"] as const;

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
 * The goal a request filters by, or why it is refused. A saved goal belongs
 * to product analytics, as the Goals table does (docs/access.md); a custom
 * event is on the page already, so it needs nothing more.
 */
async function requestGoal(
  db: Kysely<Database>,
  request: { query: GoalQuery; projectAccess: ProjectAccess | null },
): Promise<
  { goal: PageGoal | undefined } | { status: 400 | 403; problem: ReturnType<typeof problem> }
> {
  const { goal: goalId, goalEvent } = request.query;
  if (goalId !== undefined && goalEvent !== undefined) {
    return {
      status: 400,
      problem: problem("invalid_goal", "Send either goal or goalEvent, not both."),
    };
  }
  if (goalEvent !== undefined) {
    const step = stepOf({ type: "event", name: goalEvent });
    if (step === null) {
      return {
        status: 400,
        problem: problem(
          "invalid_goal",
          "goalEvent names a custom event, not one of the tracker's.",
        ),
      };
    }
    return { goal: { id: null, name: goalEvent, step } };
  }
  if (goalId === undefined) return { goal: undefined };
  const access = accessOf(request);
  if (!canUse(access.user, "product_analytics", "view")) {
    return { status: 403, problem: FORBIDDEN };
  }
  const saved = (await listGoals(db, access.projectId)).find(
    (item) => item.id.toLowerCase() === goalId.toLowerCase(),
  );
  if (saved === undefined) {
    return {
      status: 400,
      problem: problem("unknown_goal", "This goal does not exist. It may have been deleted."),
    };
  }
  return { goal: { id: saved.id, name: saved.name, step: saved.step } };
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
  app.get<{
    Params: { id: string };
    Querystring: RangeQuery & { limit?: number } & GoalQuery & Partial<Record<FilterName, string>>;
  }>(
    "/projects/:id/analytics",
    {
      preHandler: [signedIn, canView],
      preValidation: refuseUnknownParameters([
        ...Object.keys(RANGE_PROPERTIES),
        "limit",
        ...GOAL_PARAMETERS,
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
            ...GOAL_PROPERTIES,
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
      const goal = await requestGoal(db, request);
      if ("problem" in goal) return reply.code(goal.status).send(goal.problem);
      const { limit } = request.query;
      const report = await projectAnalytics(db, clickhouse, {
        projectId: request.params.id,
        environment: environmentOf(request.query.environment),
        firstDay: days.from,
        lastDay: days.to,
        timeZone,
        filters: requestFilters(request.query),
        goal: goal.goal,
        now: current,
        reader: dashboardReader(clickhouse, limiter, reply),
        ...(limit === undefined ? {} : { limit }),
      });
      // Goals belong to product analytics (docs/access.md).
      return canUse(accessOf(request).user, "product_analytics", "view")
        ? report
        : { ...report, goals: [] };
    },
  );

  /**
   * Match search case-insensitively; country lists search English names.
   * Use the same days, filters, and goal as the analytics page.
   */
  app.get<{
    Params: { id: string };
    Querystring: RangeQuery & {
      report: ListReport;
      search?: string;
      offset?: number;
      limit?: number;
    } & GoalQuery &
      Partial<Record<FilterName, string>>;
  }>(
    "/projects/:id/analytics/list",
    {
      preHandler: [signedIn, canView],
      preValidation: refuseUnknownParameters([
        ...Object.keys(RANGE_PROPERTIES),
        "report",
        "search",
        "offset",
        "limit",
        ...GOAL_PARAMETERS,
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
            ...GOAL_PROPERTIES,
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
      const goal = await requestGoal(db, request);
      if ("problem" in goal) return reply.code(goal.status).send(goal.problem);
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
        goal: goal.goal,
        reader: dashboardReader(clickhouse, limiter, reply),
        ...(search === undefined ? {} : { search }),
      });
    },
  );
  done();
};
