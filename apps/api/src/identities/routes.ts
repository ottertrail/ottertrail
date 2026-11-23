import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { canUse, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import type { Database } from "../db/schema.ts";
import { userReplays } from "../replays/list.ts";
import { replayStatuses } from "../replays/replays.ts";
import {
  ACTIVITY_PAGE_SIZE,
  listUsers,
  USERS_PAGE_SIZE,
  userActivity,
  userEnvironments,
} from "./users.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$";

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * Whether the project accepts only user IDs signed by its server
 * (docs/web-analytics.md, "Signed user IDs"). The Users pages say when it
 * does not: any page with the public key could send any ID.
 */
async function signedUserIdsRequired(db: Kysely<Database>, projectId: string): Promise<boolean> {
  const row = await db
    .selectFrom("projects")
    .select("require_signed_user_ids")
    .where("id", "=", projectId)
    .executeTakeFirst();
  return row?.require_signed_user_ids ?? false;
}

/**
 * Lists known users and their activity (users.ts). Error events include replay state;
 * the first page also includes recent replays (replays/list.ts).
 * Both routes require project access. Both answer whether the project requires
 * signed user IDs, a setting otherwise shown only with the projects permission.
 */
export const userRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
}> = (app, { db, clickhouse, auth }, done) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "users", level: "view" });
  const reader: Reader = { client: clickhouse };
  app.setErrorHandler(clickHouseErrorHandler);

  app.get<{
    Params: { id: string };
    Querystring: { environment?: string; search?: string; offset?: number; limit?: number };
  }>(
    "/projects/:id/users",
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
      const [page, signed] = await Promise.all([
        listUsers(reader, {
          projectId,
          environment,
          search,
          ...(offset === undefined ? {} : { offset }),
          ...(limit === undefined ? {} : { limit }),
        }),
        signedUserIdsRequired(db, projectId),
      ]);
      return {
        timeZone,
        environment,
        signedUserIdsRequired: signed,
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
      preHandler: [signedIn, canView],
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
      const [found, signed] = await Promise.all([
        userActivity(reader, {
          projectId,
          environment,
          userId: request.params.userId,
          before:
            occurredAt === undefined || beforeId === undefined
              ? undefined
              : { occurredAt, eventId: beforeId },
          ...(limit === undefined ? {} : { limit }),
        }),
        signedUserIdsRequired(db, projectId),
      ]);
      if (found === null) {
        return reply.code(404).send({
          error: "not_found",
          message: "No event in this environment has this user ID.",
        });
      }
      const current = new Date();
      // Replays only for those who may watch them (docs/access.md).
      const showReplays = canUse(accessOf(request).user, "replays", "view");
      const [statuses, replays] = showReplays
        ? await Promise.all([
            replayStatuses(db, projectId, found.activity, current),
            before === undefined
              ? userReplays(db, projectId, request.params.userId, environment)
              : Promise.resolve([]),
          ])
        : [new Map<string, never>(), []];
      return {
        timeZone,
        environment,
        signedUserIdsRequired: signed,
        ...found,
        activity: found.activity.map(({ replayId, ...activity }) => ({
          ...activity,
          replay:
            replayId === null || !showReplays
              ? null
              : { id: replayId, status: statuses.get(replayId) ?? "missing" },
        })),
        replays,
      };
    },
  );

  done();
};
