import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import type { Database } from "../db/schema.ts";
import { type ProjectAccess, requireProjectAccess } from "../projects/access.ts";
import {
  ACTIVITY_PAGE_SIZE,
  listUsers,
  USERS_PAGE_SIZE,
  userActivity,
  userEnvironments,
} from "./users.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
/** An ISO time as the API writes them, such as "2026-11-16T09:30:00.000Z". */
const TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$";

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * GET /api/projects/:id/users[?environment=staging&search=…&offset=0&limit=50]
 * GET /api/projects/:id/users/:userId[?environment=staging&before=…&beforeId=…&limit=100]
 *
 * The project's known users, and one user's activity (users.ts). Like
 * every project route, both run requireProjectAccess first.
 */
export const userRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
}> = (app, { db, clickhouse, auth }, done) => {
  const signedIn = requireSession(auth);
  const projectAccess = requireProjectAccess(db);
  const reader: Reader = { client: clickhouse };
  app.setErrorHandler(clickHouseErrorHandler);

  app.get<{
    Params: { id: string };
    Querystring: { environment?: string; search?: string; offset?: number; limit?: number };
  }>(
    "/projects/:id/users",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
            search: { type: "string", maxLength: 200, pattern: USER_ID_PATTERN },
            offset: { type: "integer", minimum: 0, maximum: 100_000 },
            limit: { type: "integer", minimum: 1, maximum: USERS_PAGE_SIZE },
          },
        },
      },
    },
    async (request) => {
      const { timeZone, projectId } = accessOf(request);
      const environment = environmentOf(request.query.environment);
      const { search, offset, limit } = request.query;
      const page = await listUsers(reader, {
        projectId,
        environment,
        search,
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      });
      return {
        timeZone,
        environment,
        // The page reads them from the first page only; later pages skip the scan.
        environments:
          offset === undefined || offset === 0
            ? await userEnvironments(reader, projectId, environment)
            : [],
        ...page,
      };
    },
  );

  app.get<{
    Params: { id: string; userId: string };
    Querystring: { environment?: string; before?: string; beforeId?: string; limit?: number };
  }>(
    "/projects/:id/users/:userId",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: {
          type: "object",
          required: ["id", "userId"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
            userId: { type: "string", maxLength: 200, pattern: USER_ID_PATTERN },
          },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
            before: { type: "string", pattern: TIME_PATTERN },
            beforeId: { type: "string", pattern: UUID_PATTERN },
            limit: { type: "integer", minimum: 1, maximum: ACTIVITY_PAGE_SIZE },
          },
        },
      },
    },
    async (request, reply) => {
      const { timeZone, projectId } = accessOf(request);
      const environment = environmentOf(request.query.environment);
      const { before, beforeId, limit } = request.query;
      // A page further back names the last event of the page before: both, or neither.
      if ((before === undefined) !== (beforeId === undefined)) {
        return reply
          .code(400)
          .send({ error: "invalid_query", message: "Send before and beforeId together." });
      }
      const occurredAt = before === undefined ? undefined : new Date(before);
      if (occurredAt !== undefined && Number.isNaN(occurredAt.getTime())) {
        return reply
          .code(400)
          .send({ error: "invalid_query", message: "before must be a real time." });
      }
      const found = await userActivity(reader, {
        projectId,
        environment,
        userId: request.params.userId,
        before:
          occurredAt === undefined || beforeId === undefined
            ? undefined
            : { occurredAt, eventId: beforeId },
        ...(limit === undefined ? {} : { limit }),
      });
      if (found === null) {
        return reply.code(404).send({
          error: "not_found",
          message: "No event in this environment has this user ID.",
        });
      }
      return { timeZone, environment, ...found };
    },
  );

  done();
};
