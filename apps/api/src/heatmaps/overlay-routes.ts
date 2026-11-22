import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import {
  bearerToken,
  checkProjectAccess,
  type ProjectAccess,
  requireOverlayAccess,
} from "../access/access.ts";
import {
  findOverlayLink,
  overlaySessionPath,
  OVERLAY_TOKEN_PATTERN,
  startOverlaySession,
  useOverlayLink,
} from "../access/overlay-tokens.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN } from "../collection/environment.ts";
import { isAllowedHostname, originHostname } from "../collection/normalize.ts";
import { clientKey, type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { dashboardReader, type DashboardQueryLimiter } from "../telemetry/dashboard-limit.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { heatmapRangeOf } from "./dashboard-routes.ts";
import { emptyOverlay, heatmapOverlay } from "./report.ts";
import { MAX_SNAPSHOT_BYTES, readSnapshot, saveSnapshot, storablePath } from "./snapshots.ts";
import { DEVICES, type HeatmapDevice } from "./store.ts";

/**
 * Exchanges per client address (an IPv6 address by its /64): a burst of
 * 10, then one every 30 seconds. A person opens the overlay a few times;
 * a guesser of 32-byte tokens gets nowhere either way.
 */
export const DEFAULT_OVERLAY_EXCHANGE_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 30 };
/** Reads and preflights per client address: a burst of 60, then one a second. */
export const DEFAULT_OVERLAY_READ_LIMIT: RateLimit = { capacity: 60, refillPerSecond: 1 };
/** Saved views per client address: a burst of 10, then one every 10 seconds. */
export const DEFAULT_OVERLAY_SAVE_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 10 };
/** The periods the overlay offers, in days back from today. */
export const OVERLAY_PERIODS = ["7d", "30d", "90d"] as const;
/** The exchange's body is a token in JSON: far below a kilobyte. */
const MAX_BODY_BYTES = 1024;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const PARAMS_SCHEMA = {
  type: "object",
  required: ["projectId"],
  properties: { projectId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const problem = (error: string, message: string) => ({ error, message });
const LINK_SPENT = problem(
  "link_expired",
  "This link has expired or was already used. Open it again from the dashboard.",
);
const ORIGIN_REFUSED = problem(
  "origin_not_allowed",
  "The overlay only opens on the project's allowed hostnames.",
);
const NO_ACCESS = problem("no_access", "Your account cannot view this project's heatmaps.");
const LINK_UNKNOWN = problem("link_unknown", "No overlay link has this token.");
const WRONG_PAGE = problem(
  "wrong_page",
  "This overlay session can save a view of the page its link opened only.",
);
export const SNAPSHOTS_NEED_STORE = problem(
  "object_store_not_set_up",
  "Saved views need object storage. Set OBJECT_STORE_URL on the server, then restart it.",
);

/**
 * Refuses fields the route does not take (400), where the schemas would
 * only drop them (Fastify's removeAdditional): the overlay's routes take
 * nothing else, such as a key or a token in the address.
 */
function only(part: "body" | "query", names: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value: unknown = request[part];
    if (typeof value !== "object" || value === null) return undefined;
    const extra = Object.keys(value).find((name) => !names.includes(name));
    return extra === undefined
      ? undefined
      : reply
          .code(400)
          .send(problem("invalid_request", `${part} has an unknown field: ${extra.slice(0, 50)}.`));
  };
}

/** The hostname of the request's Origin, or null without one a browser would send. */
function originOf(request: FastifyRequest): { origin: string; hostname: string } | null {
  const origin = request.headers.origin;
  if (origin === undefined) return null;
  const hostname = originHostname(origin);
  return hostname === null ? null : { origin, hostname };
}

/** Refuses a client address past its limit (429), before anything else is done. */
function limitedBy(bucket: TokenBucketLimiter) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = bucket.take(clientKey(request.ip));
    if (result.allowed) return undefined;
    return reply
      .code(429)
      .header("retry-after", String(result.retryAfterSeconds))
      .send(
        problem(
          "rate_limited",
          `Too many requests. Retry after ${result.retryAfterSeconds} seconds.`,
        ),
      );
  };
}

/** The access requireOverlayAccess set: the read always runs it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireOverlayAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * The routes the heatmap overlay (o.js) calls from the customer's own site
 * (docs/web-analytics.md, "The overlay on your site"):
 *
 *   POST    /api/heatmap-overlay/session                    { token }: link → session
 *   GET     /api/heatmap-overlay/:projectId/heatmap?path=/pricing&device=desktop&period=30d&environment=…
 *   OPTIONS /api/heatmap-overlay/:projectId/heatmap          the browser's preflight
 *   POST    /api/heatmap-overlay/:projectId/snapshot?path=/pricing   a saved view (gzip), heatmaps/snapshots.ts
 *   OPTIONS /api/heatmap-overlay/:projectId/snapshot         the browser's preflight
 *
 * No cookie and no public key plays a part. The exchange takes a link
 * token in its body and uses it once; the read takes the session token as
 * `Authorization: Bearer`, never in the address, and runs
 * requireOverlayAccess, which checks the user's role and grants on each
 * read (access/access.ts).
 *
 * CORS: once the project is known (from the link, or the read's address)
 * and the Origin is one of its allowed hostnames, the same rule collection
 * uses, the answer is readable by that page, a refusal too (a link used
 * up, no access, a session ended); before that (a limit, a malformed or
 * unknown token), by none. Never with credentials. Every answer is `Cache-Control: no-store`. Requests are
 * limited per client address before anything else, and a malformed body,
 * query, Origin, or Authorization is refused before any database work.
 */
export const heatmapOverlayRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  limiter: DashboardQueryLimiter;
  /** Where saved views go; none: saving is refused (409). */
  store?: ObjectStore | null;
  exchangeLimit?: RateLimit;
  readLimit?: RateLimit;
  saveLimit?: RateLimit;
  /** The clock that decides "today" for the period; tests fix it. */
  now?: () => Date;
}> = (app, options, done) => {
  const { db, clickhouse, limiter, store = null, now = () => new Date() } = options;
  const exchangeLimiter = new TokenBucketLimiter(
    options.exchangeLimit ?? DEFAULT_OVERLAY_EXCHANGE_LIMIT,
  );
  const readLimiter = new TokenBucketLimiter(options.readLimit ?? DEFAULT_OVERLAY_READ_LIMIT);
  const saveLimiter = new TokenBucketLimiter(options.saveLimit ?? DEFAULT_OVERLAY_SAVE_LIMIT);
  /** Requests from an origin on the project's allowed hostnames: their answers carry CORS. */
  const allowed = new WeakMap<FastifyRequest, string>();
  const canView = requireOverlayAccess(db, { area: "web_analytics", level: "view" });

  // text/plain, so the exchange is a "simple" request without a preflight.
  for (const type of ["text/plain", "application/json"]) {
    app.addContentTypeParser(
      type,
      { parseAs: "string", bodyLimit: MAX_BODY_BYTES },
      (_request, body, parsed) => {
        try {
          parsed(null, JSON.parse(String(body)));
        } catch {
          parsed(Object.assign(new Error("The body is not valid JSON"), { statusCode: 400 }));
        }
      },
    );
  }
  // A saved view: the snapshot as gzip-compressed JSON, checked by the route.
  app.addContentTypeParser(
    "application/gzip",
    { parseAs: "buffer", bodyLimit: MAX_SNAPSHOT_BYTES },
    (_request, body, parsed) => parsed(null, body),
  );

  app.addHook("onSend", async (request, reply) => {
    reply.header("cache-control", "no-store").header("vary", "Origin");
    const origin = allowed.get(request);
    if (origin !== undefined) {
      reply
        .header("access-control-allow-origin", origin)
        .header("access-control-expose-headers", "Retry-After");
    }
  });
  app.setErrorHandler(clickHouseErrorHandler);

  /**
   * The read's checks before the token is looked up: an Origin header and a
   * Bearer token of the right shape (no database work), then the Origin
   * against the project's allowed hostnames. Only then does the answer
   * carry CORS.
   */
  const fromProjectSite =
    ({ needsToken }: { needsToken: boolean }) =>
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const origin = originOf(request);
      if (origin === null) return reply.code(403).send(ORIGIN_REFUSED);
      if (needsToken && bearerToken(request.headers.authorization) === null) {
        return reply
          .code(401)
          .send(problem("invalid_token", "Send the overlay's session token as Bearer."));
      }
      const project = await db
        .selectFrom("projects")
        .select("allowed_hostnames")
        .where("id", "=", request.params.projectId)
        .executeTakeFirst();
      if (project === undefined || !isAllowedHostname(origin.hostname, project.allowed_hostnames)) {
        return reply.code(403).send(ORIGIN_REFUSED);
      }
      allowed.set(request, origin.origin);
      return undefined;
    };

  app.post<{ Body: { token: string } }>(
    "/heatmap-overlay/session",
    {
      bodyLimit: MAX_BODY_BYTES,
      onRequest: limitedBy(exchangeLimiter),
      preValidation: only("body", ["token"]),
      schema: {
        body: {
          type: "object",
          required: ["token"],
          additionalProperties: false,
          properties: { token: { type: "string", pattern: OVERLAY_TOKEN_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const origin = originOf(request);
      if (origin === null) return reply.code(403).send(ORIGIN_REFUSED);
      const clock = new Date();
      const link = await findOverlayLink(db, request.body.token, clock);
      // Never made, purged a day after it expired, or its dashboard session
      // ended: no project, so no CORS; o.js shows nothing, and the tracker
      // counts the visit.
      if (link === null) return reply.code(410).send(LINK_UNKNOWN);
      if (!isAllowedHostname(origin.hostname, link.allowedHostnames)) {
        return reply.code(403).send(ORIGIN_REFUSED);
      }
      allowed.set(request, origin.origin);
      if (link.spent || !(await useOverlayLink(db, request.body.token, clock))) {
        return reply.code(410).send(LINK_SPENT);
      }
      const checked = await checkProjectAccess(db, link.userId, link.projectId, {
        area: "web_analytics",
        level: "view",
      });
      if (!checked.ok) return reply.code(403).send(NO_ACCESS);
      const session = await startOverlaySession(db, link, link.projectId, clock);
      return {
        token: session.token,
        projectId: link.projectId,
        expiresAt: session.expiresAt.toISOString(),
        // Whether "Save this view" can work: saved views need the object store.
        snapshots: store !== null,
      };
    },
  );

  const readPath = "/heatmap-overlay/:projectId/heatmap";

  app.options<{ Params: { projectId: string } }>(
    readPath,
    {
      onRequest: limitedBy(readLimiter),
      schema: { params: PARAMS_SCHEMA },
      preHandler: fromProjectSite({ needsToken: false }),
    },
    async (_request, reply) =>
      reply
        .code(204)
        .header("access-control-allow-methods", "GET")
        .header("access-control-allow-headers", "Authorization")
        .header("access-control-max-age", "600")
        .send(),
  );

  app.get<{
    Params: { projectId: string };
    Querystring: {
      path: string;
      device: HeatmapDevice;
      period?: (typeof OVERLAY_PERIODS)[number];
      environment?: string;
    };
  }>(
    readPath,
    {
      onRequest: limitedBy(readLimiter),
      preValidation: only("query", ["path", "device", "period", "environment"]),
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          required: ["path", "device"],
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 2048, pattern: "^/" },
            device: { type: "string", enum: DEVICES },
            period: { type: "string", enum: OVERLAY_PERIODS },
            environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
          },
        },
      },
      preHandler: [fromProjectSite({ needsToken: true }), canView],
    },
    async (request, reply) => {
      const access = accessOf(request);
      const { path, device, environment } = request.query;
      const period = request.query.period ?? "30d";
      const asked = await heatmapRangeOf(
        db,
        access,
        { period, device, ...(environment === undefined ? {} : { environment }) },
        now(),
      );
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { firstDay, lastDay, clipped } = asked.answer;
      const head = {
        path,
        device,
        period,
        environment: asked.answer.environment,
        firstDay,
        lastDay,
        clipped,
      };
      if (asked.before) return { ...head, ...emptyOverlay() };
      const reader = {
        ...dashboardReader(clickhouse, limiter, reply),
        settings: DASHBOARD_SETTINGS,
      };
      return {
        ...head,
        ...(await heatmapOverlay(reader, { ...asked.range, device }, path)),
      };
    },
  );

  const savePath = "/heatmap-overlay/:projectId/snapshot";

  app.options<{ Params: { projectId: string } }>(
    savePath,
    {
      onRequest: limitedBy(readLimiter),
      schema: { params: PARAMS_SCHEMA },
      preHandler: fromProjectSite({ needsToken: false }),
    },
    async (_request, reply) =>
      reply
        .code(204)
        .header("access-control-allow-methods", "POST")
        .header("access-control-allow-headers", "Authorization, Content-Type")
        .header("access-control-max-age", "600")
        .send(),
  );

  app.post<{ Params: { projectId: string }; Querystring: { path: string }; Body: Buffer }>(
    savePath,
    {
      bodyLimit: MAX_SNAPSHOT_BYTES,
      onRequest: limitedBy(saveLimiter),
      preValidation: [only("query", ["path"]), storablePath],
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 2048, pattern: "^/" } },
        },
      },
      preHandler: [fromProjectSite({ needsToken: true }), canView],
    },
    async (request, reply) => {
      const access = accessOf(request);
      if (store === null) return reply.code(409).send(SNAPSHOTS_NEED_STORE);
      if (!Buffer.isBuffer(request.body)) {
        return reply
          .code(415)
          .send(problem("unsupported_media_type", "Send the snapshot as application/gzip."));
      }
      // The session's own page, from its link: never another page of the site.
      const token = bearerToken(request.headers.authorization) ?? "";
      const { path } = request.query;
      if ((await overlaySessionPath(db, token, access.projectId)) !== path) {
        return reply.code(403).send(WRONG_PAGE);
      }
      const read = await readSnapshot(request.body);
      if (!read.ok) return reply.code(read.status).send(read.body);
      let saved;
      try {
        saved = await saveSnapshot(
          db,
          store,
          {
            projectId: access.projectId,
            path,
            userId: access.user.userId,
            body: request.body,
            info: read.info,
          },
          request.log,
        );
      } catch (error) {
        request.log.error({ err: error }, "could not save a heatmap snapshot");
        return reply
          .code(503)
          .header("retry-after", "30")
          .send(problem("storage_unavailable", "The view could not be saved. Try again."));
      }
      if (saved === null) return reply.code(404).send(NO_ACCESS);
      return reply.code(201).send({
        path,
        device: read.info.device,
        width: read.info.width,
        savedAt: saved.savedAt.toISOString(),
      });
    },
  );

  done();
};
