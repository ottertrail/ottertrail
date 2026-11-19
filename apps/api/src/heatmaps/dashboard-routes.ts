import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { HEATMAP_RETENTION_DAYS } from "../clickhouse/migrations.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { dashboardReader, type DashboardQueryLimiter } from "../telemetry/dashboard-limit.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  emptyReport,
  heatmapEnvironments,
  heatmapPages,
  type HeatmapRange,
  heatmapReport,
} from "./report.ts";
import { DEVICES, type HeatmapDevice } from "./store.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const PARAMS_SCHEMA = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;
/** A page path as collection stores it: a "/" and at most 2,048 characters. */
const PATH_SCHEMA = { type: "string", minLength: 1, maxLength: 2048, pattern: "^/" } as const;

type Query = RangeQuery & { device?: HeatmapDevice };

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/** A "YYYY-MM-DD" moved by whole days. */
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The heatmap reports (docs/web-analytics.md, "Heatmaps"), in the Web
 * analytics area at view:
 *
 *   GET /api/projects/:id/heatmaps/pages?period=7d|from=…&to=…&environment=…&device=…&search=…
 *   GET /api/projects/:id/heatmaps?path=/pricing&period=…&environment=…&device=…
 *
 * The range is cut to the 90 days heatmap rows are kept (`clipped`). Both
 * say whether the project takes heatmaps, so the screen can say how to
 * start. Queries run with the dashboard's limits, within its shared limit
 * of queries at once, and end with the request (telemetry/dashboard-limit.ts).
 */
export const heatmapRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  limiter: DashboardQueryLimiter;
  now?: () => Date;
}> = (app, { db, clickhouse, auth, limiter, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "web_analytics", level: "view" });
  app.setErrorHandler(clickHouseErrorHandler);

  const readerOf = (reply: FastifyReply): Reader => ({
    ...dashboardReader(clickhouse, limiter, reply),
    settings: DASHBOARD_SETTINGS,
  });

  /** The range asked for, cut to what is kept, and the project's setting. */
  async function rangeOf(request: { projectAccess: ProjectAccess | null; query: Query }): Promise<
    | { problem: { error: string; message: string } }
    | {
        range: HeatmapRange;
        /** The range is wholly before the 90 days kept: nothing to read. */
        before: boolean;
        answer: {
          timeZone: string;
          environment: string;
          firstDay: string;
          lastDay: string;
          heatmaps: boolean;
          retentionDays: number;
          clipped: boolean;
          device: HeatmapDevice | null;
        };
      }
  > {
    const { projectId, timeZone } = accessOf(request);
    const today = dayIn(timeZone)(now());
    const days = requestDays(request.query, today);
    if ("problem" in days) return days;
    const firstKept = addDays(today, -(HEATMAP_RETENTION_DAYS - 1));
    const clipped = days.from < firstKept;
    // A range wholly before the kept days has nothing to read: it stays as
    // asked, and the routes answer empty.
    const before = days.to < firstKept;
    const firstDay = clipped && !before ? firstKept : days.from;
    const lastDay = days.to;
    const [{ from, to }, project] = await Promise.all([
      localDays(db, firstDay, lastDay, timeZone),
      db.selectFrom("projects").select("heatmaps").where("id", "=", projectId).executeTakeFirst(),
    ]);
    const environment = environmentOf(request.query.environment);
    return {
      range: { projectId, environment, from, to, device: request.query.device },
      before,
      answer: {
        timeZone,
        environment,
        firstDay,
        lastDay,
        heatmaps: project?.heatmaps ?? false,
        retentionDays: HEATMAP_RETENTION_DAYS,
        clipped,
        device: request.query.device ?? null,
      },
    };
  }

  const queryProperties = {
    ...RANGE_PROPERTIES,
    device: { type: "string", enum: DEVICES },
  };

  app.get<{ Params: { id: string }; Querystring: Query & { search?: string } }>(
    "/projects/:id/heatmaps/pages",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { ...queryProperties, search: { type: "string", maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      if (asked.before) {
        return { ...asked.answer, environments: [asked.answer.environment], pages: [] };
      }
      const reader = readerOf(reply);
      const [environments, pages] = await Promise.all([
        heatmapEnvironments(reader, asked.range),
        heatmapPages(reader, asked.range, request.query.search?.trim()),
      ]);
      return { ...asked.answer, environments, pages };
    },
  );

  app.get<{ Params: { id: string }; Querystring: Query & { path: string } }>(
    "/projects/:id/heatmaps",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { ...queryProperties, path: PATH_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      if (asked.before) {
        return {
          ...asked.answer,
          environments: [asked.answer.environment],
          path: request.query.path,
          ...emptyReport(),
        };
      }
      const reader = readerOf(reply);
      const [environments, report] = await Promise.all([
        heatmapEnvironments(reader, asked.range),
        heatmapReport(reader, asked.range, request.query.path),
      ]);
      return { ...asked.answer, environments, path: request.query.path, ...report };
    },
  );

  done();
};
