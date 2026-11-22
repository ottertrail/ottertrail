import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { canUse, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { localDays, previousDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { SERVICE_PATTERN, type TelemetryRange } from "../telemetry/dashboard-query.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { MAX_AI_LABEL_CHARS } from "./calls.ts";
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

/** The report's filters: the period and environment, and each label exactly as stored. */
const FILTER_PROPERTIES = {
  ...RANGE_PROPERTIES,
  service: { type: "string", pattern: SERVICE_PATTERN },
  provider: LABEL,
  model: LABEL,
  // "" is the calls that name no feature, which the page shows as "Unlabelled".
  feature: { type: "string", pattern: `^[^\\u0000-\\u001F\\u007F]{0,${MAX_AI_LABEL_CHARS}}$` },
};

type AiQuery = RangeQuery & {
  service?: string;
  provider?: string;
  model?: string;
  feature?: string;
};

/** The access requireProjectAccess set: these routes always run it. */
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
});

const schema = (extra: object = {}) => ({
  params: PARAMS,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { ...FILTER_PROPERTIES, ...extra },
  },
});

const scopeOf = (range: TelemetryRange): AiScope => ({
  projectId: range.projectId,
  environment: range.environment,
  from: range.from,
  to: range.to,
});

const answered = (range: TelemetryRange) => ({
  timeZone: range.timeZone,
  environment: range.environment,
  firstDay: range.firstDay,
  lastDay: range.lastDay,
});

/**
 * GET /api/projects/:id/ai[?period=7d|from=…&to=…&environment=…&service=…&provider=…&model=…&feature=…]
 *     (totals, the previous period's totals, breakdowns by model, feature, and user,
 *     failures by error.type, and what the filters offer)
 * GET /api/projects/:id/ai/chart[?…the same…&split=model|feature]
 *     (cost, tokens, calls, and the 95th-percentile duration per time bucket, split)
 * GET /api/projects/:id/ai/calls[?…the same…]
 *     (the latest 50 calls, with their trace and span)
 *
 * The AI page (docs/ai-usage.md, "The report"; report.ts). Each runs
 * requireProjectAccess for monitoring at view, and reads only the project
 * it found. The breakdown by user, and the user of each call, need users
 * at view too: without it, `users` is null and `usersHidden` true.
 *
 * AI calls are kept as long as the project's events, so the range is not
 * cut to the 30 days of spans.
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
  const canView = requireProjectAccess(db, { area: "monitoring", level: "view" });
  const readerOf = (reply: FastifyReply) => dashboardReader(clickhouse, limiter, reply);
  app.setErrorHandler(clickHouseErrorHandler);

  /** The request's days, in the instance's timezone; or the reason they are refused. */
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
      const moment = now();
      const asked = await rangeOf(request, moment);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const scope = scopeOf(range);
      const filters = filtersOf(request.query);
      const withUsers = canUse(accessOf(request).user, "users", "view");
      const previous = await previousDays(
        db,
        range.firstDay,
        range.lastDay,
        range.timeZone,
        moment,
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
        )),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: AiQuery }>(
    "/projects/:id/ai/calls",
    { preHandler: [signedIn, canView], schema: schema() },
    async (request, reply) => {
      const asked = await rangeOf(request, now());
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const withUsers = canUse(accessOf(request).user, "users", "view");
      return {
        ...answered(range),
        limit: RECENT_CALLS,
        usersHidden: !withUsers,
        calls: await recentAiCalls(readerOf(reply), scopeOf(range), filtersOf(request.query), {
          withUsers,
        }),
      };
    },
  );

  done();
};
