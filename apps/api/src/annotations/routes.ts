import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { accessOf, MAX_ALL_TIME_DAYS, refuseUnknownParameters } from "../reports/routes.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import {
  type AnnotationFields,
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  MAX_ANNOTATION_LENGTH,
  MAX_ANNOTATIONS,
  updateAnnotation,
} from "./annotations.ts";
import { releasesFirstSeen } from "./releases.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const TIME_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const NOTE_TEXT = /^[^\u0000-\u001F\u007F]+$/u;

const problem = (error: string, message: string) => ({ error, message });

/** Whether "YYYY-MM-DD" names a real calendar day. */
function realDay(day: string): boolean {
  const time = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === day;
}

const dayCount = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;

const PROJECT_PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};
const NOTE_PARAMS = {
  type: "object",
  required: ["id", "annotationId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    annotationId: { type: "string", pattern: UUID_PATTERN },
  },
};
const RANGE_QUERY = {
  from: { type: "string", pattern: DAY_PATTERN },
  to: { type: "string", pattern: DAY_PATTERN },
  environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
};
const NOTE_BODY = {
  type: "object",
  required: ["day", "time", "text", "environment"],
  additionalProperties: false,
  properties: {
    day: { type: "string", pattern: DAY_PATTERN },
    time: { anyOf: [{ type: "string", pattern: TIME_PATTERN }, { type: "null" }] },
    // Checked again after trimming.
    text: { type: "string", maxLength: 1000 },
    environment: {
      anyOf: [{ type: "string", pattern: ENVIRONMENT_PATTERN }, { type: "null" }],
    },
  },
};

interface NoteBody {
  day: string;
  time: string | null;
  text: string;
  environment: string | null;
}

interface RangeQuery {
  from?: string;
  to?: string;
  environment?: string;
}

/** The note's fields, or the refusal's body. */
function fieldsOf(body: NoteBody): AnnotationFields | ReturnType<typeof problem> {
  if (!realDay(body.day)) return problem("invalid_day", "The day must be a real calendar day.");
  const text = body.text.trim();
  if (text.length === 0 || text.length > MAX_ANNOTATION_LENGTH || !NOTE_TEXT.test(text)) {
    return problem(
      "invalid_text",
      `A note has 1 to ${MAX_ANNOTATION_LENGTH} characters, on one line.`,
    );
  }
  return {
    day: body.day,
    time: body.time,
    text,
    environment: body.environment === null ? null : environmentOf(body.environment),
  };
}

/**
 * Notes on the Web analytics chart, and each release's first appearance
 * (docs/web-analytics.md, "Notes and releases on the chart"). Anyone who
 * reads Web analytics reads both; changing a note needs what changing a
 * goal needs (docs/access.md). Changes require the dashboard origin.
 */
export const annotationRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** The dashboard's query limit (telemetry/dashboard-limit.ts). */
  limiter?: DashboardQueryLimiter;
}> = (
  app,
  { db, clickhouse, auth, trustedOrigins, limiter = new DashboardQueryLimiter() },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "web_analytics", level: "view" });
  const canManage = requireProjectAccess(db, { area: "product_analytics", level: "manage" });
  const fromDashboard = requireTrustedOrigin(trustedOrigins);

  app.setErrorHandler(clickHouseErrorHandler);

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/annotations",
    {
      preHandler: [signedIn, canView],
      preValidation: refuseUnknownParameters(Object.keys(RANGE_QUERY)),
      schema: {
        params: PROJECT_PARAMS,
        querystring: { type: "object", properties: RANGE_QUERY },
      },
    },
    async (request, reply) => {
      const { from, to, environment } = request.query;
      if ((from !== undefined && !realDay(from)) || (to !== undefined && !realDay(to))) {
        return reply
          .code(400)
          .send(problem("invalid_range", "from and to must be real calendar days."));
      }
      return {
        annotations: await listAnnotations(db, accessOf(request).projectId, {
          environment: environmentOf(environment),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        }),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: NoteBody }>(
    "/projects/:id/annotations",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: { params: PROJECT_PARAMS, body: NOTE_BODY },
    },
    async (request, reply) => {
      const fields = fieldsOf(request.body);
      if ("error" in fields) return reply.code(400).send(fields);
      const user = request.dashboardUser;
      if (user === null) throw new Error("requireSession must run before this route");
      const created = await createAnnotation(db, accessOf(request).projectId, user.id, fields);
      if ("refused" in created) {
        return reply
          .code(409)
          .send(
            problem(
              "too_many_annotations",
              `A project has at most ${MAX_ANNOTATIONS} notes. Delete old ones to add more.`,
            ),
          );
      }
      return reply.code(201).send({ annotation: created.annotation });
    },
  );

  app.put<{ Params: { id: string; annotationId: string }; Body: NoteBody }>(
    "/projects/:id/annotations/:annotationId",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: { params: NOTE_PARAMS, body: NOTE_BODY },
    },
    async (request, reply) => {
      const fields = fieldsOf(request.body);
      if ("error" in fields) return reply.code(400).send(fields);
      const user = request.dashboardUser;
      if (user === null) throw new Error("requireSession must run before this route");
      const updated = await updateAnnotation(
        db,
        accessOf(request).projectId,
        request.params.annotationId,
        user.id,
        fields,
      );
      return updated === null
        ? reply.code(404).send(problem("annotation_not_found", "The project has no such note."))
        : { annotation: updated };
    },
  );

  app.delete<{ Params: { id: string; annotationId: string } }>(
    "/projects/:id/annotations/:annotationId",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: { params: NOTE_PARAMS },
    },
    async (request, reply) => {
      const deleted = await deleteAnnotation(
        db,
        accessOf(request).projectId,
        request.params.annotationId,
      );
      return deleted
        ? reply.code(204).send()
        : reply.code(404).send(problem("annotation_not_found", "The project has no such note."));
    },
  );

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/release-marks",
    {
      preHandler: [signedIn, canView],
      preValidation: refuseUnknownParameters(Object.keys(RANGE_QUERY)),
      schema: {
        params: PROJECT_PARAMS,
        querystring: { type: "object", required: ["from", "to"], properties: RANGE_QUERY },
      },
    },
    async (request, reply) => {
      const { from = "", to = "", environment } = request.query;
      if (!realDay(from) || !realDay(to) || to < from) {
        return reply
          .code(400)
          .send(problem("invalid_range", "from and to must be real calendar days, from first."));
      }
      if (dayCount(from, to) > MAX_ALL_TIME_DAYS) {
        return reply
          .code(400)
          .send(problem("invalid_range", `A range covers at most ${MAX_ALL_TIME_DAYS} days.`));
      }
      const access = accessOf(request);
      const range = await localDays(db, from, to, access.timeZone);
      const releases = await releasesFirstSeen(
        dashboardReader(clickhouse, limiter, reply),
        {
          projectId: access.projectId,
          environment: environmentOf(environment),
          timeZone: access.timeZone,
        },
        range,
      );
      return { releases };
    },
  );

  done();
};
