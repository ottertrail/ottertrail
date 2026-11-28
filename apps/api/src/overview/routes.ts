import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import {
  canUse,
  type ProjectAccess,
  requireProjectAccess,
  userAccessOf,
} from "../access/access.ts";
import { readPriceBook } from "../ai/custom-prices.ts";
import { aiModels, aiTotals, hasAiCalls } from "../ai/report.ts";
import { DEFAULT_CERTIFICATE_DAYS } from "../alerts/kinds.ts";
import { visibleKinds } from "../alerts/routes.ts";
import { firingAlerts } from "../alerts/rules.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { countGroups, countOccurrences, hasErrors, listErrors } from "../errors/errors.ts";
import { listGoals } from "../goals/goals.ts";
import {
  breakdown,
  goalCounts,
  localDays,
  type PreviousDays,
  previousDays,
  type ReportRange,
  summary,
  timeseries,
  topPages,
  visitorCount,
} from "../reports/reports.ts";
import { periodCalendar, periodDays } from "../reports/routes.ts";
import { hasVitals, speedByDevice, THRESHOLDS } from "../speed/speed.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { DASHBOARD_SETTINGS, hasAnyRow } from "../telemetry/dashboard-query.ts";
import { serviceTotals } from "../telemetry/services.ts";
import { incidentCounts, listChecks, uptimes } from "../uptime/checks.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { readLayout, resetLayout, saveLayout, WIDGET_IDS, type WidgetId } from "./layout.ts";
import { newUsers, signedInUsers, type UsersScope } from "./signed-in-users.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

/**
 * The overview's periods, a month at most, so every widget stays quick. Each
 * compares with as many days right before it; month to date with the same
 * days of the month before.
 */
export const OVERVIEW_PERIODS = ["today", "yesterday", "7d", "30d", "mtd"] as const;
type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];

interface OverviewQuery {
  period?: OverviewPeriod;
  environment?: string;
}

const QUERY = {
  type: "object",
  additionalProperties: false,
  properties: {
    period: { type: "string", enum: OVERVIEW_PERIODS },
    environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
  },
};

const TOP_ROWS = 5;
const TOP_AI_MODELS = 3;

const DAY_MS = 86_400_000;

const rate = (reached: number, of: number) => (of === 0 ? 0 : reached / of);

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

interface OverviewRange {
  projectId: string;
  environment: string;
  timeZone: string;
  firstDay: string;
  lastDay: string;
  from: Date;
  to: Date;
  previous: PreviousDays;
  today: string;
  now: Date;
}

const header = (range: OverviewRange) => ({
  timeZone: range.timeZone,
  environment: range.environment,
  firstDay: range.firstDay,
  lastDay: range.lastDay,
  previous: { firstDay: range.previous.firstDay, lastDay: range.previous.lastDay },
});

/** Compare running periods up to the same time of day as analytics. */
const previousOf = (range: ReportRange, previous: PreviousDays): ReportRange => ({
  ...range,
  from: previous.from,
  to: previous.to,
  until: previous.until ?? undefined,
});

const usersScope = (range: OverviewRange): UsersScope => ({
  projectId: range.projectId,
  environment: range.environment,
  timeZone: range.timeZone,
  from: range.from,
  to: range.to,
  previousFrom: range.previous.from,
  previousTo: range.previous.to,
});

/**
 * Layout belongs to the user and project (docs/dashboard.md, "Overview").
 * Each widget route checks its own area and fails independently.
 * Apply DASHBOARD_SETTINGS and the shared DashboardQueryLimiter to queries.
 */
export const overviewRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  trustedOrigins: readonly string[];
  limiter?: DashboardQueryLimiter;
  now?: () => Date;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    trustedOrigins,
    limiter = new DashboardQueryLimiter(),
    now = () => new Date(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const reachProject = requireProjectAccess(db, "project");
  app.setErrorHandler(clickHouseErrorHandler);

  /** Apply dashboard limits and cancel queries when the request ends. */
  const readerOf = (reply: FastifyReply): Reader => ({
    ...dashboardReader(clickhouse, limiter, reply),
    settings: DASHBOARD_SETTINGS,
  });

  async function rangeOf(request: FastifyRequest<{ Querystring: OverviewQuery }>) {
    const { projectId, timeZone } = accessOf(request);
    // One reading of the clock: the period and its comparison agree.
    const moment = now();
    const today = dayIn(timeZone)(moment);
    const period = request.query.period ?? "7d";
    const { from: firstDay, to: lastDay } = periodDays(period, today);
    const [days, previous] = await Promise.all([
      localDays(db, firstDay, lastDay, timeZone),
      previousDays(db, firstDay, lastDay, timeZone, moment, periodCalendar(period)),
    ]);
    return {
      projectId,
      environment: environmentOf(request.query.environment),
      timeZone,
      firstDay,
      lastDay,
      ...days,
      previous,
      today,
      now: moment,
    } satisfies OverviewRange;
  }

  async function reportRange(range: OverviewRange): Promise<ReportRange> {
    const project = await db
      .selectFrom("projects")
      .select("allowed_hostnames")
      .where("id", "=", range.projectId)
      .executeTakeFirst();
    return {
      projectId: range.projectId,
      environment: range.environment,
      timeZone: range.timeZone,
      from: range.from,
      to: range.to,
      ownHostnames: project?.allowed_hostnames ?? [],
    };
  }

  function widget(
    id: WidgetId,
    area: Parameters<typeof canUse>[1],
    answer: (
      range: OverviewRange,
      context: { reader: Reader; request: FastifyRequest },
    ) => Promise<object>,
  ) {
    app.get<{ Params: { id: string }; Querystring: OverviewQuery }>(
      `/projects/:id/overview/${id}`,
      {
        preHandler: [signedIn, requireProjectAccess(db, { area, level: "view" })],
        schema: { params: PARAMS, querystring: QUERY },
      },
      async (request, reply) => {
        const range = await rangeOf(request);
        return {
          ...header(range),
          ...(await answer(range, { reader: readerOf(reply), request })),
        };
      },
    );
  }

  app.get<{ Params: { id: string } }>(
    "/projects/:id/overview/layout",
    { preHandler: [signedIn, reachProject], schema: { params: PARAMS } },
    async (request) => readLayout(db, userAccessOf(request), accessOf(request).projectId),
  );

  const widgetList = {
    type: "array",
    maxItems: WIDGET_IDS.length,
    uniqueItems: true,
    items: { type: "string", enum: WIDGET_IDS },
  };
  app.put<{ Params: { id: string }; Body: { order: WidgetId[]; hidden: WidgetId[] } }>(
    "/projects/:id/overview/layout",
    {
      preHandler: [fromDashboard, signedIn, reachProject],
      schema: {
        params: PARAMS,
        body: {
          type: "object",
          required: ["order", "hidden"],
          additionalProperties: false,
          properties: { order: widgetList, hidden: widgetList },
        },
      },
    },
    async (request) =>
      saveLayout(db, userAccessOf(request), accessOf(request).projectId, request.body),
  );

  app.delete<{ Params: { id: string } }>(
    "/projects/:id/overview/layout",
    { preHandler: [fromDashboard, signedIn, reachProject], schema: { params: PARAMS } },
    async (request) => resetLayout(db, userAccessOf(request), accessOf(request).projectId),
  );

  widget("attention", "uptime_alerts", async (range, { request }) => {
    const { user } = accessOf(request);
    const [alerts, checks, rules] = await Promise.all([
      firingAlerts(db, range.projectId, visibleKinds(user)),
      listChecks(db, range.projectId),
      db
        .selectFrom("alert_rules")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("project_id", "=", range.projectId)
        .where("enabled", "=", true)
        .where("kind", "in", [...visibleKinds(user)])
        .executeTakeFirstOrThrow(),
    ]);
    const alerted = new Set(
      alerts.filter((alert) => alert.kind === "certificate_expiring").map((a) => a.subject),
    );
    const soon = range.now.getTime() + DEFAULT_CERTIFICATE_DAYS * DAY_MS;
    const active = checks.filter((check) => !check.paused);
    return {
      alerts: alerts.map(({ ruleId, ruleName, kind, subjectName, since, message }) => ({
        ruleId,
        ruleName,
        kind,
        subjectName,
        since,
        message,
      })),
      down: active
        .filter((check) => check.state === "down")
        .map((check) => ({
          checkId: check.id,
          name: check.name,
          url: check.url,
          since: check.failingSince,
          cause: check.failingCause ?? check.lastCause,
          statusCode: check.lastStatusCode,
        })),
      certificates: active
        .filter(
          (check) =>
            check.tlsExpiresAt !== null &&
            check.tlsExpiresAt.getTime() <= soon &&
            !alerted.has(check.id),
        )
        .map((check) => ({
          checkId: check.id,
          name: check.name,
          url: check.url,
          expiresAt: check.tlsExpiresAt,
          expired: check.tlsExpiresAt !== null && check.tlsExpiresAt <= range.now,
        })),
      checks: {
        total: checks.length,
        up: active.filter((check) => check.state === "up").length,
        paused: checks.length - active.length,
      },
      rules: Number(rules.count),
    };
  });

  widget("errors", "errors", async (range, { reader }) => {
    const scope = { projectId: range.projectId, environment: range.environment };
    // Occurrence and new-group counts are complete. Regressed and unresolved
    // counts use the MAX_GROUPS most recent groups; truncated flags omissions.
    const [{ groups, truncated }, inPeriod, previousOccurrences, counted, received] =
      await Promise.all([
        listErrors(reader, db, { ...scope, ...range }, "all"),
        countOccurrences(reader, { ...scope, from: range.from, to: range.to }),
        countOccurrences(reader, { ...scope, from: range.previous.from, to: range.previous.to }),
        countGroups(reader, { ...scope, from: range.from, to: range.to }),
        hasErrors(reader, range.projectId, range.environment),
      ]);
    return {
      received,
      occurrences: inPeriod,
      previousOccurrences,
      newGroups: counted.new,
      regressedGroups: groups.filter((group) => group.status === "regressed").length,
      unresolvedGroups: groups.filter((group) => group.status !== "resolved").length,
      top: groups
        .filter((group) => group.status !== "resolved")
        .toSorted(
          (a, b) =>
            b.users - a.users ||
            b.visitors - a.visitors ||
            b.occurrences - a.occurrences ||
            a.fingerprint.localeCompare(b.fingerprint),
        )
        .slice(0, TOP_ROWS)
        .map(({ fingerprint, type, message, occurrences, users, visitors, status, firstSeen }) => ({
          fingerprint,
          type,
          message,
          occurrences,
          users,
          visitors,
          status,
          isNew: firstSeen >= range.from,
        })),
      truncated,
    };
  });

  widget("uptime", "uptime_alerts", async (range) => {
    const checks = await listChecks(db, range.projectId);
    const [shares, incidents] = await Promise.all([
      uptimes(
        db,
        range.projectId,
        checks,
        [
          { from: range.from, to: range.to },
          { from: range.previous.from, to: range.previous.to },
        ],
        range.now,
      ),
      incidentCounts(db, range.projectId, range.from, range.to),
    ]);
    return {
      checks: checks.map((check) => {
        const [uptime = null, previousUptime = null] = shares.get(check.id) ?? [];
        return {
          id: check.id,
          name: check.name,
          url: check.url,
          state: check.state,
          paused: check.paused,
          uptime,
          previousUptime,
          incidents: incidents.get(check.id) ?? 0,
          lastResponseMs: check.lastResponseMs,
        };
      }),
    };
  });

  widget("services", "monitoring", async (range, { reader }) => {
    const { services, more } = await serviceTotals(reader, {
      projectId: range.projectId,
      environment: range.environment,
      from: range.from,
      to: range.to,
      previousFrom: range.previous.from,
      previousTo: range.previous.to,
    });
    return {
      services,
      more,
      received: services.length > 0 || (await hasAnyRow(reader, "spans", range.projectId)),
    };
  });

  widget("ai-cost", "ai", async (range, { reader }) => {
    const scope = {
      projectId: range.projectId,
      environment: range.environment,
      from: range.from,
      to: range.to,
      prices: await readPriceBook(db),
    };
    const [totals, previous, models, received] = await Promise.all([
      aiTotals(reader, scope, {}),
      aiTotals(reader, { ...scope, from: range.previous.from, to: range.previous.to }, {}),
      aiModels(reader, scope, {}),
      hasAiCalls(reader, range.projectId),
    ]);
    return {
      received,
      costUsd: totals.costUsd,
      calls: totals.calls,
      noPriceCalls: totals.noPriceCalls,
      previousCostUsd: previous.costUsd,
      previousCalls: previous.calls,
      models: models
        .filter((row) => !row.other && row.costUsd > 0)
        .slice(0, TOP_AI_MODELS)
        .map(({ model, costUsd, calls }) => ({ model, costUsd, calls })),
    };
  });

  widget("speed", "web_analytics", async (range, { reader }) => {
    const devices = await speedByDevice(reader, range);
    return {
      thresholds: { lcp: THRESHOLDS.lcp, inp: THRESHOLDS.inp, cls: THRESHOLDS.cls },
      devices,
      received: devices.length > 0 || (await hasVitals(reader, range.projectId, range.environment)),
    };
  });

  async function mainGoalOf(projectId: string) {
    const [project, goals] = await Promise.all([
      db
        .selectFrom("projects")
        .select("main_goal_id")
        .where("id", "=", projectId)
        .executeTakeFirst(),
      listGoals(db, projectId),
    ]);
    return { mainGoalId: project?.main_goal_id ?? null, goals };
  }

  async function countGoals(
    reader: Reader,
    range: OverviewRange,
    goals: Awaited<ReturnType<typeof listGoals>>,
  ) {
    const current = await reportRange(range);
    const before = previousOf(current, range.previous);
    const steps = goals.map((goal) => goal.step);
    const [counts, previousCounts, visitors, previousVisitors] = await Promise.all([
      goalCounts(reader, current, steps),
      goalCounts(reader, before, steps),
      visitorCount(reader, current),
      visitorCount(reader, before),
    ]);
    return {
      visitors,
      previousVisitors,
      goals: goals.map((goal, index) => {
        const reached = counts[index] ?? { visitors: 0, events: 0 };
        const then = previousCounts[index] ?? { visitors: 0, events: 0 };
        return {
          id: goal.id,
          name: goal.name,
          step: goal.step,
          ...reached,
          conversionRate: rate(reached.visitors, visitors),
          previous: { ...then, conversionRate: rate(then.visitors, previousVisitors) },
        };
      }),
    };
  }

  // Use new signed-in users when no main goal is configured.
  widget("main-goal", "product_analytics", async (range, { reader }) => {
    const { mainGoalId, goals } = await mainGoalOf(range.projectId);
    const goal = goals.find((item) => item.id === mainGoalId);
    if (goal !== undefined) {
      const counted = await countGoals(reader, range, [goal]);
      return {
        kind: "goal",
        visitors: counted.visitors,
        previousVisitors: counted.previousVisitors,
        goal: counted.goals[0],
      };
    }
    const users = await newUsers(reader, usersScope(range));
    return {
      kind: "new_users",
      newUsers: users.new,
      previousNewUsers: users.previousNew,
      received: users.received,
    };
  });

  widget("traffic", "web_analytics", async (range, { reader }) => {
    const current = await reportRange(range);
    const [counted, before, days, project] = await Promise.all([
      summary(reader, current),
      summary(reader, previousOf(current, range.previous)),
      timeseries(reader, current),
      db
        .selectFrom("projects")
        .select("last_event_at")
        .where("id", "=", range.projectId)
        .executeTakeFirst(),
    ]);
    const figures = ({ visitors, visits, pageviews }: typeof counted) => ({
      visitors,
      visits,
      pageviews,
    });
    return {
      received: (project?.last_event_at ?? null) !== null,
      summary: figures(counted),
      previousSummary: figures(before),
      days: days.map(({ day, visitors }) => ({ day, visitors })),
    };
  });

  widget("goals", "product_analytics", async (range, { reader }) => {
    const { mainGoalId, goals } = await mainGoalOf(range.projectId);
    if (goals.length === 0) {
      return { mainGoalId, visitors: 0, previousVisitors: 0, goals: [] };
    }
    return { mainGoalId, ...(await countGoals(reader, range, goals)) };
  });

  // User IDs require users access (docs/access.md).
  widget("users", "product_analytics", async (range, { reader, request }) => {
    const withNewest = canUse(accessOf(request).user, "users", "view");
    const users = await signedInUsers(reader, {
      ...usersScope(range),
      today: range.today,
      withNewest,
    });
    return { ...users, newest: withNewest ? (users.newest ?? []) : null };
  });

  widget("sources", "web_analytics", async (range, { reader }) => {
    const current = await reportRange(range);
    const [sources, pages] = await Promise.all([
      breakdown(reader, current, "source", TOP_ROWS),
      topPages(reader, current, TOP_ROWS),
    ]);
    return {
      sources: sources.map(({ value, visitors }) => ({ value, visitors })),
      pages: pages.map(({ path, visitors }) => ({ path, visitors })),
    };
  });

  done();
};
