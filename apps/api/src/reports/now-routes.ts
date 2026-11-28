import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import {
  DashboardQueryLimiter,
  liveQueryLimiter,
  liveReader,
} from "../telemetry/dashboard-limit.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { projectNow, windowStart } from "./now.ts";
import { localDays } from "./reports.ts";
import {
  accessOf,
  PARAMS_SCHEMA,
  RANGE_PROPERTIES,
  type RangeQuery,
  refuseUnknownParameters,
} from "./routes.ts";

/**
 * Right now (now.ts; docs/web-analytics.md, "Right now"), with the Web
 * analytics page's access. Polled every 15 seconds while a page shows it,
 * so it holds a live poll's place in the dashboard's query limit and is
 * never cached.
 */
export const nowRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  /** The dashboard's query limit (telemetry/dashboard-limit.ts). */
  limiter?: DashboardQueryLimiter;
  /** Live polls acquire this pool before `limiter` (liveReader). */
  liveLimiter?: DashboardQueryLimiter;
  now?: () => Date;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    limiter = new DashboardQueryLimiter(),
    liveLimiter = liveQueryLimiter(),
    now = () => new Date(),
  },
  done,
) => {
  // For these routes only (clickhouse/route-errors.ts).
  app.setErrorHandler(clickHouseErrorHandler);
  app.get<{ Params: { id: string }; Querystring: Pick<RangeQuery, "environment"> }>(
    "/projects/:id/analytics/now",
    {
      preHandler: [
        requireSession(auth),
        requireProjectAccess(db, { area: "web_analytics", level: "view" }),
      ],
      preValidation: refuseUnknownParameters(["environment"]),
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { environment: RANGE_PROPERTIES.environment },
        },
      },
    },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const current = now();
      const day = dayIn(timeZone)(windowStart(current));
      const [{ from: dayStart }, project] = await Promise.all([
        localDays(db, day, day, timeZone),
        db
          .selectFrom("projects")
          .select("allowed_hostnames")
          .where("id", "=", projectId)
          .executeTakeFirstOrThrow(),
      ]);
      const environment = environmentOf(request.query.environment);
      const answer = await projectNow(
        { ...liveReader(clickhouse, limiter, liveLimiter, reply), settings: DASHBOARD_SETTINGS },
        { projectId, environment, ownHostnames: project.allowed_hostnames, now: current, dayStart },
      );
      void reply.header("cache-control", "no-store");
      return { timeZone, environment, at: current.toISOString(), ...answer };
    },
  );
  done();
};
