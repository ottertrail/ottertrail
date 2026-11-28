import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import type { Database } from "../db/schema.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import type { Analytics } from "./analytics.ts";
import { attachment, csvFileName, csvLines } from "./csv.ts";
import { chartTable, type CsvTable, listFileName, listTable, summaryTable } from "./export.ts";
import { MAX_EXPORT_ROWS } from "./reports.ts";
import {
  type AnalyticsQuery,
  analyticsAnswer,
  analyticsQueryChecks,
  dashboardScope,
  type ListQuery,
  listAnswer,
  listQueryChecks,
  PARAMS_SCHEMA,
  type RangeQuery,
} from "./routes.ts";

/** Says that a list had more rows than the file holds: the file's rows, the cap. */
export const CUT_HEADER = "x-export-cut";

async function projectName(db: Kysely<Database>, projectId: string): Promise<string> {
  const row = await db
    .selectFrom("projects")
    .select("name")
    .where("id", "=", projectId)
    .executeTakeFirst();
  return row?.name ?? "";
}

function sendCsv(reply: FastifyReply, fileName: string, table: CsvTable) {
  return reply
    .header("content-type", "text/csv; charset=utf-8; header=present")
    .header("content-disposition", attachment(fileName))
    .header("cache-control", "no-store")
    .send(csvLines(table.header, table.rows));
}

/**
 * The Web analytics page's CSV exports (docs/web-analytics.md, "CSV
 * export"), with the page's query checks, access, reader, and limiter. A
 * list holds at most MAX_EXPORT_ROWS rows, which bounds its memory.
 * Shared links have none.
 */
export const reportExportRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  limiter?: DashboardQueryLimiter;
  now?: () => Date;
}> = (
  app,
  { db, clickhouse, auth, limiter = new DashboardQueryLimiter(), now = () => new Date() },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "web_analytics", level: "view" });
  app.setErrorHandler(clickHouseErrorHandler);

  const listChecks = listQueryChecks({ environment: true, paged: false });
  app.get<{
    Params: { id: string };
    Querystring: Omit<ListQuery, "offset" | "limit"> & Pick<RangeQuery, "environment">;
  }>(
    "/projects/:id/analytics/export/list",
    {
      preHandler: [signedIn, canView],
      preValidation: listChecks.preValidation,
      schema: { params: PARAMS_SCHEMA, querystring: listChecks.querystring },
    },
    async (request, reply) => {
      const scope = dashboardScope(request);
      const { query } = request;
      const answer = await listAnswer(
        db,
        clickhouse,
        scope,
        { ...query, offset: 0, limit: MAX_EXPORT_ROWS },
        { now: now(), reader: dashboardReader(clickhouse, limiter, reply) },
      );
      if ("status" in answer) return reply.code(answer.status).send(answer.body);
      const goal =
        (query.goal !== undefined || query.goalEvent !== undefined) &&
        query.report !== "customEvents";
      const cut = answer.list.hasMore;
      if (cut) reply.header(CUT_HEADER, String(MAX_EXPORT_ROWS));
      return sendCsv(
        reply,
        csvFileName(
          await projectName(db, scope.projectId),
          listFileName(query.report),
          answer,
          cut ? `first-${MAX_EXPORT_ROWS}` : undefined,
        ),
        listTable(query.report, answer.list.rows, goal),
      );
    },
  );

  const pageChecks = analyticsQueryChecks({ environment: true, limit: false });
  const pageExport = (part: "summary" | "chart", table: (analytics: Analytics) => CsvTable) =>
    app.get<{
      Params: { id: string };
      Querystring: Omit<AnalyticsQuery, "limit"> & Pick<RangeQuery, "environment">;
    }>(
      `/projects/:id/analytics/export/${part}`,
      {
        preHandler: [signedIn, canView],
        preValidation: pageChecks.preValidation,
        schema: { params: PARAMS_SCHEMA, querystring: pageChecks.querystring },
      },
      async (request, reply) => {
        const scope = dashboardScope(request);
        // The page's lists come with it; one row each keeps them small.
        const answer = await analyticsAnswer(
          db,
          clickhouse,
          scope,
          { ...request.query, limit: 1 },
          { now: now(), reader: dashboardReader(clickhouse, limiter, reply) },
        );
        if ("status" in answer) return reply.code(answer.status).send(answer.body);
        const { report } = answer;
        const what = part === "chart" ? `chart-by-${report.interval}` : part;
        return sendCsv(
          reply,
          csvFileName(await projectName(db, scope.projectId), what, report),
          table(report),
        );
      },
    );
  pageExport("summary", summaryTable);
  pageExport("chart", chartTable);
  done();
};
