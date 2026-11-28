import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { canUse, FORBIDDEN, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import type { Database } from "../db/schema.ts";
import { localDays, previousDays } from "../reports/reports.ts";
import {
  periodCalendar,
  RANGE_PROPERTIES,
  type RangeQuery,
  requestDays,
} from "../reports/routes.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { SERVICE_PATTERN, type TelemetryRange } from "../telemetry/dashboard-query.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { MAX_AI_LABEL_CHARS } from "./calls.ts";
import { readPriceBook } from "./custom-prices.ts";
import type { PriceBook } from "./prices.ts";
import {
  aiChart,
  aiFailures,
  aiFeatures,
  aiLabels,
  aiModels,
  type AiScope,
  type AiSplit,
  aiTotals,
  aiUsers,
  hasAiCalls,
  MAX_LISTED_FEATURES,
  MAX_LISTED_MODELS,
  MAX_LISTED_USERS,
  RECENT_CALLS,
  recentAiCalls,
  SPLITS,
} from "./report.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

/** A label as a filter: what the rows can hold (ai/calls.ts), with no control characters. */
const LABEL = { type: "string", pattern: `^[^\\u0000-\\u001F\\u007F]{1,${MAX_AI_LABEL_CHARS}}$` };

const FILTER_PROPERTIES = {
  ...RANGE_PROPERTIES,
  service: { type: "string", pattern: SERVICE_PATTERN },
  provider: LABEL,
  model: LABEL,
  // "" is the calls that name no feature, which the page shows as "Unlabeled".
  feature: { type: "string", pattern: `^[^\\u0000-\\u001F\\u007F]{0,${MAX_AI_LABEL_CHARS}}$` },
  // One end user's calls, as user IDs are taken everywhere; needs the users area (userRefused).
  user: { type: "string", maxLength: 200, pattern: USER_ID_PATTERN },
};

type AiQuery = RangeQuery & {
  service?: string;
  provider?: string;
  model?: string;
  feature?: string;
  user?: string;
};

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

const filtersOf = (query: AiQuery) => ({
  service: query.service,
  provider: query.provider,
  model: query.model,
  feature: query.feature,
  user: query.user,
});

/** Refuse user filters without users view access (403); never fall back to all users. */
const userRefused = (request: { query: AiQuery; projectAccess: ProjectAccess | null }) =>
  request.query.user !== undefined && !canUse(accessOf(request).user, "users", "view");

const schema = (extra: object = {}) => ({
  params: PARAMS,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { ...FILTER_PROPERTIES, ...extra },
  },
});

const scopeOf = (range: TelemetryRange, prices: PriceBook): AiScope => ({
  projectId: range.projectId,
  environment: range.environment,
  from: range.from,
  to: range.to,
  prices,
});

const answered = (range: TelemetryRange) => ({
  timeZone: range.timeZone,
  environment: range.environment,
  firstDay: range.firstDay,
  lastDay: range.lastDay,
});

/**
 * AI report routes (docs/ai-usage.md, "The report"; report.ts). requireProjectAccess scopes
 * each route to AI view access. Without users view access, hide user breakdowns and call users,
 * and refuse user filters with 403. Calls follow project event retention. Read current custom
 * prices for each request (custom-prices.ts).
 */
export const aiRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  now?: () => Date;
  /** Queries in flight on this process (telemetry/dashboard-limit.ts), shared with the telemetry pages. */
  limiter?: DashboardQueryLimiter;
}> = (
  app,
  { db, clickhouse, auth, now = () => new Date(), limiter = new DashboardQueryLimiter() },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "ai", level: "view" });
  const readerOf = (reply: FastifyReply) => dashboardReader(clickhouse, limiter, reply);
  app.setErrorHandler(clickHouseErrorHandler);

  async function rangeOf(
    request: { query: AiQuery; projectAccess: ProjectAccess | null },
    moment: Date,
  ): Promise<{ range: TelemetryRange } | { problem: { error: string; message: string } }> {
    const { projectId, timeZone } = accessOf(request);
    const days = requestDays(request.query, dayIn(timeZone)(moment));
    if ("problem" in days) return days;
    const { from, to } = await localDays(db, days.from, days.to, timeZone);
    return {
      range: {
        projectId,
        environment: environmentOf(request.query.environment),
        timeZone,
        firstDay: days.from,
        lastDay: days.to,
        dayStart: from,
        from,
        to,
      },
    };
  }

  app.get<{ Params: { id: string }; Querystring: AiQuery }>(
    "/projects/:id/ai",
    { preHandler: [signedIn, canView], schema: schema() },
    async (request, reply) => {
      if (userRefused(request)) return reply.code(403).send(FORBIDDEN);
      const moment = now();
      const asked = await rangeOf(request, moment);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const scope = scopeOf(range, await readPriceBook(db));
      const filters = filtersOf(request.query);
      const withUsers = canUse(accessOf(request).user, "users", "view");
      const previous = await previousDays(
        db,
        range.firstDay,
        range.lastDay,
        range.timeZone,
        moment,
        periodCalendar(request.query.period),
      );
      const reader = readerOf(reply);
      const [totals, previousTotals, models, features, users, failures, labels, received] =
        await Promise.all([
          aiTotals(reader, scope, filters),
          aiTotals(reader, { ...scope, from: previous.from, to: previous.to }, filters),
          aiModels(reader, scope, filters),
          aiFeatures(reader, scope, filters),
          withUsers ? aiUsers(reader, scope, filters) : Promise.resolve(null),
          aiFailures(reader, scope, filters),
          aiLabels(reader, scope),
          hasAiCalls(reader, range.projectId),
        ]);
      return {
        ...answered(range),
        environments: labels.environments,
        services: labels.services,
        filterOptions: {
          services: labels.services,
          providers: labels.providers,
          models: labels.models,
          features: labels.features,
        },
        received,
        totals,
        previous: {
          firstDay: previous.firstDay,
          lastDay: previous.lastDay,
          until: previous.until,
          totals: previousTotals,
        },
        models,
        features,
        users,
        usersHidden: !withUsers,
        failures,
        limits: {
          models: MAX_LISTED_MODELS,
          features: MAX_LISTED_FEATURES,
          users: MAX_LISTED_USERS,
        },
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: AiQuery & { split?: AiSplit } }>(
    "/projects/:id/ai/chart",
    {
      preHandler: [signedIn, canView],
      schema: schema({ split: { type: "string", enum: SPLITS } }),
    },
    async (request, reply) => {
      if (userRefused(request)) return reply.code(403).send(FORBIDDEN);
      const moment = now();
      const asked = await rangeOf(request, moment);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      return {
        ...answered(range),
        ...(await aiChart(
          readerOf(reply),
          range,
          filtersOf(request.query),
          request.query.split ?? "model",
          moment,
          await readPriceBook(db),
        )),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: AiQuery }>(
    "/projects/:id/ai/calls",
    { preHandler: [signedIn, canView], schema: schema() },
    async (request, reply) => {
      if (userRefused(request)) return reply.code(403).send(FORBIDDEN);
      const asked = await rangeOf(request, now());
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const withUsers = canUse(accessOf(request).user, "users", "view");
      return {
        ...answered(range),
        limit: RECENT_CALLS,
        usersHidden: !withUsers,
        calls: await recentAiCalls(
          readerOf(reply),
          scopeOf(range, await readPriceBook(db)),
          filtersOf(request.query),
          { withUsers },
        ),
      };
    },
  );

  done();
};
