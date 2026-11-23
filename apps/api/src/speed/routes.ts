import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  DEVICE_TYPES,
  type DeviceType,
  speedEnvironments,
  speedReport,
  THRESHOLDS,
} from "./speed.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/** Web Vitals report access uses the project Web analytics area (speed.ts). */
export const speedRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  now?: () => Date;
}> = (app, { db, clickhouse, auth, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "web_analytics", level: "view" });
  const reader: Reader = { client: clickhouse };
  app.setErrorHandler(clickHouseErrorHandler);

  app.get<{ Params: { id: string }; Querystring: RangeQuery & { device?: DeviceType } }>(
    "/projects/:id/speed",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { ...RANGE_PROPERTIES, device: { type: "string", enum: DEVICE_TYPES } },
        },
      },
    },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const days = requestDays(request.query, dayIn(timeZone)(now()));
      if ("problem" in days) return reply.code(400).send(days.problem);
      const { from, to } = await localDays(db, days.from, days.to, timeZone);
      const range = {
        projectId,
        environment: environmentOf(request.query.environment),
        timeZone,
        firstDay: days.from,
        lastDay: days.to,
        from,
        to,
        deviceType: request.query.device,
      };
      const [report, environments] = await Promise.all([
        speedReport(reader, range),
        speedEnvironments(reader, range),
      ]);
      return {
        timeZone,
        environment: range.environment,
        environments,
        firstDay: range.firstDay,
        lastDay: range.lastDay,
        device: range.deviceType ?? null,
        thresholds: THRESHOLDS,
        ...report,
      };
    },
  );

  done();
};
