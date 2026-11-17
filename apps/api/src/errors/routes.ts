import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { type ProjectAccess, requireProjectAccess } from "../organizations/access.ts";
import { signedInUser } from "../organizations/routes.ts";
import { localDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { resolveStack, type SourceMapCache } from "../source-maps/resolve.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  type ErrorRange,
  errorDetail,
  errorEnvironments,
  listErrors,
  setResolution,
  STATUS_FILTERS,
  type StatusFilter,
} from "./errors.ts";
import { FINGERPRINT_PATTERN } from "./fingerprint.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const GROUP_PARAMS = {
  type: "object",
  required: ["id", "fingerprint"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    fingerprint: { type: "string", pattern: FINGERPRINT_PATTERN },
  },
};

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * GET   /api/projects/:id/errors[?period=7d|from=…&to=…&environment=…&status=unresolved]
 * GET   /api/projects/:id/errors/:fingerprint[?period=…&environment=…]
 *       (the latest stack's frames mapped to the original source by the
 *       project's source maps for its release: ../source-maps/resolve.ts)
 * PATCH /api/projects/:id/errors/:fingerprint  { "status": "resolved" | "unresolved" }
 *
 * The project's error groups, one group's detail, and its status
 * (errors.ts). Like every project route, each runs requireProjectAccess
 * first; the PATCH also needs the dashboard's origin.
 */
export const errorRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** Where the project's source maps are; no store, no mapping. */
  sourceMaps: { store: ObjectStore | null; cache: SourceMapCache };
  now?: () => Date;
}> = (app, { db, clickhouse, auth, trustedOrigins, sourceMaps, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const projectAccess = requireProjectAccess(db);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const reader: Reader = { client: clickhouse };
  app.setErrorHandler(clickHouseErrorHandler);

  /** The request's days, in the organization's timezone; or the reason it is refused. */
  async function rangeOf(request: {
    query: RangeQuery;
    projectAccess: ProjectAccess | null;
  }): Promise<{ range: ErrorRange } | { problem: { error: string; message: string } }> {
    const { projectId, timeZone } = accessOf(request);
    const days = requestDays(request.query, dayIn(timeZone)(now()));
    if ("problem" in days) return days;
    const { from, to } = await localDays(db, days.from, days.to, timeZone);
    return {
      range: {
        projectId,
        environment: environmentOf(request.query.environment),
        timeZone,
        firstDay: days.from,
        lastDay: days.to,
        from,
        to,
      },
    };
  }

  app.get<{ Params: { id: string }; Querystring: RangeQuery & { status?: StatusFilter } }>(
    "/projects/:id/errors",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            status: { type: "string", enum: STATUS_FILTERS },
          },
        },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const status = request.query.status ?? "unresolved";
      const [{ groups, truncated }, environments] = await Promise.all([
        listErrors(reader, db, range, status),
        errorEnvironments(reader, range),
      ]);
      return {
        timeZone: range.timeZone,
        environment: range.environment,
        environments,
        firstDay: range.firstDay,
        lastDay: range.lastDay,
        status,
        groups,
        truncated,
      };
    },
  );

  app.get<{ Params: { id: string; fingerprint: string }; Querystring: RangeQuery }>(
    "/projects/:id/errors/:fingerprint",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: GROUP_PARAMS,
        querystring: { type: "object", additionalProperties: false, properties: RANGE_PROPERTIES },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const detail = await errorDetail(reader, db, range, request.params.fingerprint);
      if (detail === null) {
        // Not "not_found", which the access check answers for an unknown project.
        return reply.code(404).send({
          error: "no_occurrences",
          message: "This error has no occurrence in the range and environment.",
        });
      }
      // The stack is the latest occurrence's, so its release is the one to map with.
      const resolved =
        detail.stack === null
          ? null
          : await resolveStack(
              {
                db,
                ...sourceMaps,
                onError: (error) => request.log.warn({ err: error }, "could not read a source map"),
              },
              range.projectId,
              detail.occurrences[0]?.release ?? null,
              detail.stack,
            );
      return {
        timeZone: range.timeZone,
        environment: range.environment,
        firstDay: range.firstDay,
        lastDay: range.lastDay,
        ...detail,
        frames: resolved?.frames ?? null,
        sourceMaps:
          resolved === null
            ? null
            : { status: resolved.status, release: resolved.release, paths: resolved.paths },
      };
    },
  );

  app.patch<{
    Params: { id: string; fingerprint: string };
    Body: { status: "resolved" | "unresolved" };
  }>(
    "/projects/:id/errors/:fingerprint",
    {
      preHandler: [fromDashboard, signedIn, projectAccess],
      schema: {
        params: GROUP_PARAMS,
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: { status: { type: "string", enum: ["resolved", "unresolved"] } },
        },
      },
    },
    async (request) => {
      const { projectId } = accessOf(request);
      const resolution = await setResolution(db, {
        projectId,
        fingerprint: request.params.fingerprint,
        resolved: request.body.status === "resolved",
        userId: signedInUser(request).id,
      });
      return {
        fingerprint: request.params.fingerprint,
        resolvedAt: resolution?.resolvedAt ?? null,
      };
    },
  );

  done();
};
