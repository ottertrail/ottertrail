import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { findProject } from "../projects/projects.ts";
import { projectAnalytics } from "./analytics.ts";
import { MAX_LIMIT } from "./reports.ts";

/** The longest range one request may cover, to bound the work it causes. */
export const MAX_RANGE_DAYS = 366;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/** Milliseconds since 1970 for a "YYYY-MM-DD" that names a real calendar day, or null. */
function dayNumber(day: string): number | null {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== day ? null : time;
}

function problem(code: string, message: string) {
  return { error: code, message };
}

/**
 * GET /api/projects/:id/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD[&limit=10]
 *
 * Every report of the analytics page for whole days in the instance's
 * timezone, from and to included (see analytics.ts).
 */
export const reportRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  timeZone: string;
}> = (app, { db, auth, timeZone }, done) => {
  app.get<{ Params: { id: string }; Querystring: { from: string; to: string; limit?: number } }>(
    "/projects/:id/analytics",
    {
      preHandler: requireSession(auth),
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
        querystring: {
          type: "object",
          required: ["from", "to"],
          additionalProperties: false,
          properties: {
            from: { type: "string", pattern: DAY_PATTERN },
            to: { type: "string", pattern: DAY_PATTERN },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
          },
        },
      },
    },
    async (request, reply) => {
      const { from, to, limit } = request.query;
      const first = dayNumber(from);
      const last = dayNumber(to);
      if (first === null || last === null) {
        return reply
          .code(400)
          .send(problem("invalid_range", "from and to must be real calendar days."));
      }
      if (last < first) {
        return reply.code(400).send(problem("invalid_range", "to must not be before from."));
      }
      if ((last - first) / 86_400_000 + 1 > MAX_RANGE_DAYS) {
        return reply
          .code(400)
          .send(problem("invalid_range", `A range covers at most ${MAX_RANGE_DAYS} days.`));
      }
      if ((await findProject(db, request.params.id)) === null) {
        return reply.code(404).send(problem("not_found", "No project has this ID."));
      }
      return projectAnalytics(db, {
        projectId: request.params.id,
        firstDay: from,
        lastDay: to,
        timeZone,
        ...(limit === undefined ? {} : { limit }),
      });
    },
  );
  done();
};
