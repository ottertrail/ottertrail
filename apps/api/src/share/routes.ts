import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import { contentTypeOf } from "../avatars/avatars.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { DEFAULT_ENVIRONMENT, ENVIRONMENT_PATTERN } from "../collection/environment.ts";
import {
  ClientRateLimiter,
  type RateLimit,
  TokenBucketLimiter,
} from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import type { Analytics, GoalResult, PageGoalResult } from "../reports/analytics.ts";
import { nowAnswer } from "../reports/now-routes.ts";
import {
  accessOf,
  type AnalyticsQuery,
  analyticsAnswer,
  analyticsQueryChecks,
  type ListQuery,
  listAnswer,
  listQueryChecks,
  PARAMS_SCHEMA,
  refuseUnknownParameters,
  type ReportScope,
} from "../reports/routes.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import {
  DashboardQueryLimiter,
  dashboardReader,
  LIVE_QUEUE_WAIT_MS,
} from "../telemetry/dashboard-limit.ts";
import {
  createShareLink,
  deleteShareLink,
  findShareLink,
  listShareLinks,
  markOpened,
  MAX_LINKS,
  type OpenedLink,
} from "./links.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const LINK_NAME = /^[^\u0000-\u001F\u007F]{1,100}$/u;

const problem = (error: string, message: string) => ({ error, message });

/**
 * Making, listing, and revoking a project's shared links: the `projects`
 * permission, as the project's keys and settings need, since a link shows
 * the project's data to anyone who has it (docs/access.md). Changes need
 * the dashboard's origin.
 */
export const shareLinkRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  publicUrl: string;
}> = (app, { db, auth, trustedOrigins, publicUrl }, done) => {
  const signedIn = requireSession(auth);
  const canManage = requireProjectAccess(db, { permission: "projects" });
  const fromDashboard = requireTrustedOrigin(trustedOrigins);

  app.get<{ Params: { id: string } }>(
    "/projects/:id/share-links",
    { preHandler: [signedIn, canManage], schema: { params: PARAMS_SCHEMA } },
    async (request) => ({
      links: await listShareLinks(db, accessOf(request).projectId),
      maxLinks: MAX_LINKS,
    }),
  );

  app.post<{ Params: { id: string }; Body: { name: string; environment?: string } }>(
    "/projects/:id/share-links",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: {
        params: PARAMS_SCHEMA,
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", maxLength: 200 },
            environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!LINK_NAME.test(name)) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_name",
              "A link's name has 1 to 100 characters, and no control characters.",
            ),
          );
      }
      const created = await createShareLink(db, {
        projectId: accessOf(request).projectId,
        name,
        environment: (request.body.environment ?? DEFAULT_ENVIRONMENT).toLowerCase(),
        createdBy: signedInUser(request).id,
      });
      if (created === null) {
        return reply.code(404).send(problem("not_found", "No project has this ID."));
      }
      if ("refused" in created) {
        return reply
          .code(409)
          .send(
            problem(
              "too_many_links",
              `A project has at most ${MAX_LINKS} shared links. Revoke one to make another.`,
            ),
          );
      }
      // The only time the token leaves the server.
      void reply.header("cache-control", "no-store");
      return reply.code(201).send({
        link: created.link,
        url: new URL(`/share/${created.token}`, publicUrl).toString(),
      });
    },
  );

  app.delete<{ Params: { id: string; linkId: string } }>(
    "/projects/:id/share-links/:linkId",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: {
        params: {
          type: "object",
          required: ["id", "linkId"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
            linkId: { type: "string", pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const deleted = await deleteShareLink(db, accessOf(request).projectId, request.params.linkId);
      return deleted
        ? reply.code(204).send()
        : reply.code(404).send(problem("link_not_found", "The project has no link with this ID."));
    },
  );

  done();
};

/**
 * Requests per client address, an IPv6 address by its /64: a page opens
 * with three or four, then polls Right now every 15 seconds and the
 * reports every minute, and a full list asks as its search is typed.
 */
export const SHARE_IP_LIMIT: RateLimit = { capacity: 60, refillPerSecond: 1 };
/** Requests per link, from every address together: a link may be open in many browsers. */
export const SHARE_LINK_LIMIT: RateLimit = { capacity: 300, refillPerSecond: 5 };

/**
 * Shared links' own query limits, apart from the dashboard's, so public
 * traffic never takes the slots signed-in users read with: one report
 * query at a time per process, and one Right now.
 */
export const shareReportLimiter = () => new DashboardQueryLimiter({ max: 1 });
export const shareLiveLimiter = () =>
  new DashboardQueryLimiter({ max: 1, waitMs: LIVE_QUEUE_WAIT_MS });

/**
 * A shared link's goals: their names and counts only. What a goal matches
 * (its step, with any event property filter) is Product analytics' setup,
 * which a link does not show; the goal filter still takes the goal's ID.
 */
function publicGoals(report: Analytics): SharedAnalytics {
  const { goals, goal, ...rest } = report;
  return {
    ...rest,
    goals: goals.map(({ id, name, visitors, events, conversionRate }) => ({
      id,
      name,
      visitors,
      events,
      conversionRate,
    })),
    goal: goal === null ? null : withoutStep(goal),
  };
}

const withoutStep = ({ step: _step, ...goal }: PageGoalResult): Omit<PageGoalResult, "step"> =>
  goal;

/** The Web analytics page as a shared link answers it. */
type SharedAnalytics = Omit<Analytics, "goals" | "goal"> & {
  goals: Pick<GoalResult, "id" | "name" | "visitors" | "events" | "conversionRate">[];
  goal: Omit<PageGoalResult, "step"> | null;
};

/** One answer for a malformed, unknown, or revoked token, so none can be told apart. */
export const LINK_NOT_FOUND = problem(
  "not_found",
  "This link does not work. It may have been revoked, or copied incompletely.",
);

const tooMany = (reply: FastifyReply, retryAfterSeconds: number) =>
  reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send(problem("rate_limited", "Too many requests. Wait a moment, then reload the page."));

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the shared link routes' check, before their handlers. */
    shareLink: OpenedLink | null;
  }
}

function linkOf(request: FastifyRequest): OpenedLink {
  if (request.shareLink === null) throw new Error("the share link check must run first");
  return request.shareLink;
}

/**
 * The public routes of a shared link (docs/access.md, "Public routes"):
 * `/api/share/:token…`. No session: the token is the capability, and it
 * reaches its own project's Web analytics, in its own environment, only.
 * Nothing in a request names another: the routes take no project ID, and
 * refuse an `environment`. The answers are the dashboard's reports, from
 * the same functions, so they hold aggregates only: no visitor, user ID,
 * or replay. Limited per client address and per link, within the
 * dashboard's query limit; never cached, never indexed.
 */
export const shareRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  store: ObjectStore | null;
  /** The reports' query limit, apart from the dashboard's: by default, shareReportLimiter(). */
  reportLimiter?: DashboardQueryLimiter;
  /** Right now's, apart from the dashboard's: by default, shareLiveLimiter(). */
  liveLimiter?: DashboardQueryLimiter;
  ipLimit?: RateLimit;
  linkLimit?: RateLimit;
  now?: () => Date;
}> = (
  app,
  {
    db,
    clickhouse,
    store,
    reportLimiter = shareReportLimiter(),
    liveLimiter = shareLiveLimiter(),
    ipLimit = SHARE_IP_LIMIT,
    linkLimit = SHARE_LINK_LIMIT,
    now = () => new Date(),
  },
  done,
) => {
  const byAddress = new ClientRateLimiter(ipLimit);
  const byLink = new TokenBucketLimiter(linkLimit);

  app.decorateRequest("shareLink", null);
  // For these routes only (clickhouse/route-errors.ts).
  app.setErrorHandler(clickHouseErrorHandler);
  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex, nofollow")
      .header("referrer-policy", "no-referrer");
  });

  /** The address's limit, before any database work; then the token; then the link's limit. */
  async function openLink(
    request: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply,
  ) {
    const fromAddress = byAddress.take(request.ip);
    if (!fromAddress.allowed) return tooMany(reply, fromAddress.retryAfterSeconds);
    const link = await findShareLink(db, request.params.token);
    if (link === null) return reply.code(404).send(LINK_NOT_FOUND);
    const forLink = byLink.take(link.linkId);
    if (!forLink.allowed) return tooMany(reply, forLink.retryAfterSeconds);
    request.shareLink = link;
    return undefined;
  }

  async function scopeOf(request: FastifyRequest): Promise<ReportScope> {
    const { projectId, environment } = linkOf(request);
    const { timeZone } = await readInstanceSettings(db);
    // A link is made by the owner or an admin, who see the goals; publicGoals strips their setup.
    return { projectId, environment, timeZone, savedGoals: true };
  }

  const tokenParams = {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string" } },
  };

  /** What the shared page shows around the reports: the project's name and icon. */
  app.get<{ Params: { token: string } }>(
    "/share/:token",
    {
      preHandler: openLink,
      preValidation: refuseUnknownParameters([]),
      schema: { params: tokenParams },
    },
    async (request) => {
      const link = linkOf(request);
      const [project, { timeZone }] = await Promise.all([
        db
          .selectFrom("projects")
          .select(["name", "avatar_key", "favicon_key"])
          .where("id", "=", link.projectId)
          .executeTakeFirstOrThrow(),
        readInstanceSettings(db),
        markOpened(db, link.linkId, now()),
      ]);
      const hasIcon = store !== null && (project.avatar_key ?? project.favicon_key) !== null;
      return {
        project: {
          name: project.name,
          iconUrl: hasIcon ? `/api/share/${encodeURIComponent(request.params.token)}/icon` : null,
        },
        environment: link.environment,
        timeZone,
      };
    },
  );

  app.get<{ Params: { token: string } }>(
    "/share/:token/icon",
    {
      preHandler: openLink,
      preValidation: refuseUnknownParameters([]),
      schema: { params: tokenParams },
    },
    async (request, reply) => {
      const project = await db
        .selectFrom("projects")
        .select(["avatar_key", "favicon_key"])
        .where("id", "=", linkOf(request).projectId)
        .executeTakeFirstOrThrow();
      const key = project.avatar_key ?? project.favicon_key;
      const bytes = key === null || store === null ? null : await store.get(key);
      if (key === null || bytes === null) {
        return reply.code(404).send(problem("not_found", "This project has no icon."));
      }
      return reply
        .header("content-type", contentTypeOf(key))
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(Buffer.from(bytes));
    },
  );

  const analyticsChecks = analyticsQueryChecks({ environment: false });
  app.get<{ Params: { token: string }; Querystring: AnalyticsQuery }>(
    "/share/:token/analytics",
    {
      preHandler: openLink,
      preValidation: analyticsChecks.preValidation,
      schema: { params: tokenParams, querystring: analyticsChecks.querystring },
    },
    async (request, reply) => {
      const scope = await scopeOf(request);
      const answer = await analyticsAnswer(db, clickhouse, scope, request.query, {
        now: now(),
        reader: dashboardReader(clickhouse, reportLimiter, reply),
      });
      if ("status" in answer) return reply.code(answer.status).send(answer.body);
      // The link's environment is the only one it shows.
      return { ...publicGoals(answer.report), environments: [scope.environment] };
    },
  );

  const listChecks = listQueryChecks({ environment: false });
  app.get<{ Params: { token: string }; Querystring: ListQuery }>(
    "/share/:token/analytics/list",
    {
      preHandler: openLink,
      preValidation: listChecks.preValidation,
      schema: { params: tokenParams, querystring: listChecks.querystring },
    },
    async (request, reply) => {
      const answer = await listAnswer(db, clickhouse, await scopeOf(request), request.query, {
        now: now(),
        reader: dashboardReader(clickhouse, reportLimiter, reply),
      });
      return "status" in answer ? reply.code(answer.status).send(answer.body) : answer.list;
    },
  );

  app.get<{ Params: { token: string } }>(
    "/share/:token/analytics/now",
    {
      preHandler: openLink,
      preValidation: refuseUnknownParameters([]),
      schema: { params: tokenParams },
    },
    async (request, reply) =>
      nowAnswer(db, dashboardReader(clickhouse, liveLimiter, reply), await scopeOf(request), now()),
  );

  done();
};
