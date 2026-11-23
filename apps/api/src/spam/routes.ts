import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import type { Database } from "../db/schema.ts";
import { parseBlockedReferrer } from "../projects/blocked-referrers.ts";
import { deleteReplays } from "../replays/replays.ts";
import { localDays } from "../reports/reports.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  countSpamVisits,
  deleteSpamVisits,
  MAX_VISITS_PER_DELETE,
  PartialSpamDeletionError,
  type SpamFilters,
} from "./delete-visits.ts";

/** The longest period one delete covers: about a quarter, so its query stays within its time limit. */
export const MAX_SPAM_PERIOD_DAYS = 92;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

interface FilterBody {
  /** The period's first and last day ("YYYY-MM-DD"), in the instance's timezone. */
  from: string;
  to: string;
  referrer?: string;
  path?: string;
  country?: string;
}

const FILTER_PROPERTIES = {
  from: { type: "string", pattern: DAY_PATTERN },
  to: { type: "string", pattern: DAY_PATTERN },
  // A domain; its subdomains match too.
  referrer: { type: "string", minLength: 1, maxLength: 300 },
  path: { type: "string", minLength: 1, maxLength: 2048, pattern: "^/" },
  country: { type: "string", pattern: "^[A-Za-z]{2}$" },
} as const;

const params = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

function problem(error: string, message: string) {
  return { error, message };
}

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

function isDay(text: string): boolean {
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

/** Days from one "YYYY-MM-DD" to another, counting both. */
function daysBetween(first: string, last: string): number {
  return (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000 + 1;
}

/**
 * Spam deletion needs projects permission and the dashboard Origin
 * (docs/web-analytics.md, "Deleting spam"). Refuse if the confirmed visit count
 * changed since preview.
 */
export const spamRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  store: ObjectStore | null;
  auth: Auth;
  trustedOrigins: readonly string[];
  now?: () => Date;
}> = (app, { db, clickhouse, store, auth, trustedOrigins, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const manageProject = requireProjectAccess(db, { permission: "projects" });
  app.setErrorHandler(clickHouseErrorHandler);

  async function filtersOf(
    request: { body: FilterBody; projectAccess: ProjectAccess | null },
    reply: FastifyReply,
  ): Promise<SpamFilters | null> {
    const { projectId, timeZone } = accessOf(request);
    const { from, to, referrer, path, country } = request.body;
    const refuse = (message: string) => {
      void reply.code(400).send(problem("invalid_request", message));
      return null;
    };
    if (!isDay(from) || !isDay(to)) return refuse("from and to must be days, such as 2026-11-16.");
    if (from > to) return refuse("The period must end on or after the day it starts.");
    const today = dayIn(timeZone)(now());
    if (to > today) return refuse("The period cannot end after today.");
    if (daysBetween(from, to) > MAX_SPAM_PERIOD_DAYS) {
      return refuse(`The period is at most ${MAX_SPAM_PERIOD_DAYS} days.`);
    }
    // Within the project's retention: older events are deleted already.
    const { rows } = await sql<{ first: string | null }>`
      select case when retention_days is null then null
             else to_char((${now()}::timestamptz at time zone ${timeZone})::date - retention_days, 'YYYY-MM-DD')
             end as first
      from projects where id = ${projectId}
    `.execute(db);
    const first = rows[0]?.first ?? null;
    if (first !== null && from < first) {
      return refuse(`The project keeps events from ${first} on. Start the period then or later.`);
    }
    // Without a filter, every visit of the period would go.
    if (referrer === undefined && path === undefined && country === undefined) {
      return refuse(
        "Choose at least one filter: a referrer domain, a page path, or a country. Without one, every visit of the period would be deleted.",
      );
    }
    let referrerDomain: string | undefined;
    if (referrer !== undefined) {
      const domain = parseBlockedReferrer(referrer);
      if (domain === null) return refuse("referrer must be a domain, such as spam.example.");
      referrerDomain = domain;
    }
    const days = await localDays(db, from, to, timeZone);
    return {
      projectId,
      from: days.from,
      to: days.to,
      referrerDomain,
      path,
      country: country?.toUpperCase(),
    };
  }

  app.post<{ Params: { id: string }; Body: FilterBody }>(
    "/projects/:id/spam-visits/preview",
    {
      preHandler: [fromDashboard, signedIn, manageProject],
      schema: {
        params,
        body: {
          type: "object",
          required: ["from", "to"],
          additionalProperties: false,
          properties: FILTER_PROPERTIES,
        },
      },
    },
    async (request, reply) => {
      const filters = await filtersOf(request, reply);
      if (filters === null) return reply;
      const counts = await countSpamVisits(clickhouse, filters);
      return { ...counts, limit: MAX_VISITS_PER_DELETE };
    },
  );

  app.post<{ Params: { id: string }; Body: FilterBody & { confirmVisits: number } }>(
    "/projects/:id/spam-visits/delete",
    {
      preHandler: [fromDashboard, signedIn, manageProject],
      schema: {
        params,
        body: {
          type: "object",
          required: ["from", "to", "confirmVisits"],
          additionalProperties: false,
          properties: {
            ...FILTER_PROPERTIES,
            // The number of visits the user typed, from the preview.
            confirmVisits: { type: "integer", minimum: 1, maximum: MAX_VISITS_PER_DELETE },
          },
        },
      },
    },
    async (request, reply) => {
      const filters = await filtersOf(request, reply);
      if (filters === null) return reply;
      let result;
      try {
        result = await deleteSpamVisits(
          db,
          clickhouse,
          filters,
          request.body.confirmVisits,
          store === null
            ? {}
            : {
                deleteReplays: (replayIds: string[]) =>
                  deleteReplays(db, store, filters.projectId, replayIds),
              },
        );
      } catch (error) {
        if (!(error instanceof PartialSpamDeletionError)) throw error;
        request.log.error(
          {
            err: error.cause,
            userId: accessOf(request).user.userId,
            projectId: filters.projectId,
            deletedVisits: error.deletedVisits,
            totalVisits: error.totalVisits,
          },
          "a spam delete failed partway",
        );
        return reply
          .code(500)
          .send(
            problem(
              "delete_failed",
              "The delete stopped partway: some visits may have been deleted. Count the visits again, then delete what is left.",
            ),
          );
      }
      if (!result.ok) {
        return result.reason === "too_many"
          ? reply
              .code(409)
              .send(
                problem(
                  "too_many_visits",
                  `More than ${MAX_VISITS_PER_DELETE} visits match. Choose a shorter period or narrower filters, and delete in parts.`,
                ),
              )
          : reply
              .code(409)
              .send(
                problem(
                  "visits_changed",
                  `${result.visits} visits match now, not ${request.body.confirmVisits}. Count the visits again.`,
                ),
              );
      }
      const { replaysDeleted } = result;
      // The audit record: who, which project, the filters, and the counts. No address.
      const { from, to, referrer, path, country } = request.body;
      request.log.info(
        {
          userId: accessOf(request).user.userId,
          projectId: filters.projectId,
          filters: { from, to, referrer: filters.referrerDomain ?? referrer, path, country },
          counts: result.counts,
          replaysDeleted,
        },
        "deleted spam visits",
      );
      return { ...result.counts, replaysDeleted };
    },
  );

  done();
};
