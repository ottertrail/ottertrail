import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { findProject } from "../projects/projects.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { projectAnalytics } from "./analytics.ts";
import { MAX_LIMIT } from "./reports.ts";

/** The longest range one request may cover, to bound the work it causes. */
export const MAX_RANGE_DAYS = 366;

/** Ranges that end today in the instance's timezone, which the browser does not know. */
export const PERIODS = ["today", "7d", "30d", "90d", "12m"] as const;
export type Period = (typeof PERIODS)[number];

/** "YYYY-MM-DD" moved by whole days and months on the calendar. */
function shiftDay(
  day: string,
  { days = 0, months = 0 }: { days?: number; months?: number },
): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, date + days)).toISOString().slice(0, 10);
}

/** Days before today that each fixed-length period starts. */
const DAYS_BACK: Record<Exclude<Period, "12m">, number> = {
  today: 0,
  "7d": 6,
  "30d": 29,
  "90d": 89,
};

/** The first and last day of a period that ends on `today`, both included. */
export function periodDays(period: Period, today: string): { from: string; to: string } {
  const from =
    period === "12m"
      ? // From the day after the same date last year: 365 or 366 days.
        shiftDay(shiftDay(today, { months: -12 }), { days: 1 })
      : shiftDay(today, { days: -DAYS_BACK[period] });
  return { from, to: today };
}

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
 * GET /api/projects/:id/analytics?period=7d[&limit=10]
 *
 * Every report of the analytics page for whole days in the instance's
 * timezone, from and to included (see analytics.ts). A period (today, 7d,
 * 30d, 90d, 12m) ends today in that timezone.
 */
export const reportRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  timeZone: string;
  now?: () => Date;
}> = (app, { db, auth, timeZone, now = () => new Date() }, done) => {
  const today = dayIn(timeZone);
  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string; period?: Period; limit?: number };
  }>(
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
          additionalProperties: false,
          properties: {
            from: { type: "string", pattern: DAY_PATTERN },
            to: { type: "string", pattern: DAY_PATTERN },
            period: { type: "string", enum: PERIODS },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
          },
        },
      },
    },
    async (request, reply) => {
      const { period, limit } = request.query;
      if (
        period !== undefined &&
        (request.query.from !== undefined || request.query.to !== undefined)
      ) {
        return reply
          .code(400)
          .send(problem("invalid_range", "Send either period, or from and to, not both."));
      }
      const days =
        period === undefined
          ? { from: request.query.from, to: request.query.to }
          : periodDays(period, today(now()));
      if (days.from === undefined || days.to === undefined) {
        return reply.code(400).send(problem("invalid_range", "Send period, or both from and to."));
      }
      const { from, to } = days;
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
