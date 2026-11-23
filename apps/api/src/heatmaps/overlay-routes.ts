import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import {
  bearerToken,
  can,
  checkProjectAccess,
  type ProjectAccess,
  requireOverlayAccess,
} from "../access/access.ts";
import {
  findOverlayLink,
  isOverlayToken,
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
import {
  MAX_SNAPSHOT_BYTES,
  readSnapshot,
  saveSnapshot,
  SNAPSHOT_TOO_LARGE,
  storablePath,
} from "./snapshots.ts";
import { DEVICES, type HeatmapDevice } from "./store.ts";

/** Per address (IPv6 /64): burst 10, then one exchange every 30 seconds. */
export const DEFAULT_OVERLAY_EXCHANGE_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 30 };
/** Reads and preflights per address: burst 60, then one per second. */
export const DEFAULT_OVERLAY_READ_LIMIT: RateLimit = { capacity: 60, refillPerSecond: 1 };
/** Saves per address: burst 10, then one every 10 seconds. */
export const DEFAULT_OVERLAY_SAVE_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 1 / 10 };
/**
 * Malformed requests use a separate bucket to preserve legitimate capacity. Well-formed fake
 * tokens still spend normal limits because scripts on the owner's page can send them.
 */
export const DEFAULT_OVERLAY_MALFORMED_LIMIT: RateLimit = { capacity: 30, refillPerSecond: 1 };
/** Days back from today. */
export const OVERLAY_PERIODS = ["7d", "30d", "90d"] as const;
/** Token-only JSON fits well below a kilobyte. */
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
  "The overlay only opens on the project's allowed hostnames, over https (or http on localhost).",
);
const NO_ACCESS = problem("no_access", "Your account cannot view this project's heatmaps.");
const NO_TOKEN = problem("invalid_token", "Send the overlay's session token as Bearer.");
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
 * Reject unknown fields with 400 before Fastify's removeAdditional drops them, including keys or
 * tokens in query strings.
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

/**
 * Allow HTTP only for secure local contexts: localhost, .localhost, and 127.0.0.1 on any port.
 * Require HTTPS elsewhere.
 */
const isLocalHostname = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");

/**
 * Overlay origins require HTTPS or local HTTP (isLocalHostname). Collection allows either scheme
 * (collection/normalize.ts).
 */
function originOf(request: FastifyRequest): { origin: string; hostname: string } | null {
  const origin = request.headers.origin;
  if (origin === undefined) return null;
  const hostname = originHostname(origin);
  if (hostname === null) return null;
  const secure = origin.toLowerCase().startsWith("https:");
  return secure || isLocalHostname(hostname) ? { origin, hostname } : null;
}

function charge(bucket: TokenBucketLimiter, request: FastifyRequest, reply: FastifyReply) {
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
}

function limitedBy(bucket: TokenBucketLimiter) {
  return async (request: FastifyRequest, reply: FastifyReply) => charge(bucket, request, reply);
}

/** requireOverlayAccess runs before this. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireOverlayAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * Overlay routes run on customer sites (docs/web-analytics.md, "The overlay on your site").
 * Exchange link tokens once in request bodies; send session tokens as Authorization: Bearer.
 * requireOverlayAccess checks database roles and grants on every read (access/access.ts). Cookies
 * and public keys grant no access.
 *
 * Enable credential-free CORS only after identifying the project and matching an allowed Origin,
 * including refusals. Unknown/malformed tokens get no CORS. Every response uses Cache-Control:
 * no-store. Limit addresses first; reject malformed bodies, queries, Origins, and Authorization
 * before database work.
 */
export const heatmapOverlayRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  limiter: DashboardQueryLimiter;
  /** Without an object store, saves return 409. */
  store?: ObjectStore | null;
  exchangeLimit?: RateLimit;
  readLimit?: RateLimit;
  saveLimit?: RateLimit;
  malformedLimit?: RateLimit;
  /** Controls "today"; injectable for tests. */
  now?: () => Date;
}> = (app, options, done) => {
  const { db, clickhouse, limiter, store = null, now = () => new Date() } = options;
  const exchangeLimiter = new TokenBucketLimiter(
    options.exchangeLimit ?? DEFAULT_OVERLAY_EXCHANGE_LIMIT,
  );
  const readLimiter = new TokenBucketLimiter(options.readLimit ?? DEFAULT_OVERLAY_READ_LIMIT);
  const saveLimiter = new TokenBucketLimiter(options.saveLimit ?? DEFAULT_OVERLAY_SAVE_LIMIT);
  const malformedLimiter = new TokenBucketLimiter(
    options.malformedLimit ?? DEFAULT_OVERLAY_MALFORMED_LIMIT,
  );
  /** Only allowed project origins receive CORS headers. */
  const allowed = new WeakMap<FastifyRequest, string>();
  const canView = requireOverlayAccess(db, { area: "web_analytics", level: "view" });
  // Saving and deleting views requires owner/admin access.
  const canSave = requireOverlayAccess(db, { permission: "projects" });

  /**
   * Valid Bearer form spends the normal bucket; malformed form spends the malformed bucket and
   * returns 401. No database access.
   */
  const bearerFirst =
    (bucket: TokenBucketLimiter) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (bearerToken(request.headers.authorization) !== null) {
        return charge(bucket, request, reply);
      }
      return charge(malformedLimiter, request, reply) ?? reply.code(401).send(NO_TOKEN);
    };

  // text/plain avoids preflight. Fastify rejects __proto__ and constructor keys.
  const parseJson = app.getDefaultJsonParser("error", "error");
  for (const type of ["text/plain", "application/json"]) {
    app.addContentTypeParser(
      type,
      { parseAs: "string", bodyLimit: MAX_BODY_BYTES },
      (request, body, parsed) => {
        // The default parser invokes its callback synchronously.
        void parseJson(request, String(body), (error, value) => {
          if (error === null) {
            parsed(null, value);
            return;
          }
          const limited = !malformedLimiter.take(clientKey(request.ip)).allowed;
          parsed(
            Object.assign(
              new Error(limited ? "Too many requests." : "The body is not valid JSON"),
              {
                statusCode: limited ? 429 : 400,
              },
            ),
          );
        });
      },
    );
  }
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
   * Validate Origin and Bearer form before lookup. Set CORS only after matching the project's
   * allowed hostnames.
   */
  const fromProjectSite =
    ({ needsToken }: { needsToken: boolean }) =>
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const origin = originOf(request);
      if (origin === null) return reply.code(403).send(ORIGIN_REFUSED);
      if (needsToken && bearerToken(request.headers.authorization) === null) {
        return reply.code(401).send(NO_TOKEN);
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
      // Charge valid token forms to the exchange bucket; all others to the malformed bucket.
      preValidation: [
        async (request, reply) => {
          const body: unknown = request.body;
          const token =
            typeof body === "object" && body !== null ? Reflect.get(body, "token") : undefined;
          const wellFormed = typeof token === "string" && isOverlayToken(token);
          return charge(wellFormed ? exchangeLimiter : malformedLimiter, request, reply);
        },
        only("body", ["token"]),
      ],
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
      // Unknown, purged, or ended links have no project for CORS. The overlay stays hidden and
      // tracking continues.
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
        snapshots: store !== null,
        // Advertises owner/admin access; the save route rechecks.
        canSave: can(checked.access.user, "projects"),
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
      onRequest: bearerFirst(readLimiter),
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
      // Check Origin, Bearer form, and declared size before reading bodies or accessing the
      // database.
      onRequest: async (request, reply) => {
        const length = Number(request.headers["content-length"] ?? Number.NaN);
        let refused: { status: number; body: { error: string; message: string } } | null = null;
        if (originOf(request) === null) refused = { status: 403, body: ORIGIN_REFUSED };
        else if (bearerToken(request.headers.authorization) === null) {
          refused = { status: 401, body: NO_TOKEN };
        } else if (!Number.isSafeInteger(length) || length < 1) {
          refused = {
            status: 411,
            body: problem("length_required", "Send the snapshot with a Content-Length."),
          };
        } else if (length > MAX_SNAPSHOT_BYTES) refused = { status: 413, body: SNAPSHOT_TOO_LARGE };
        if (refused === null) return charge(saveLimiter, request, reply);
        return (
          charge(malformedLimiter, request, reply) ?? reply.code(refused.status).send(refused.body)
        );
      },
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
      preHandler: [fromProjectSite({ needsToken: true }), canSave],
    },
    async (request, reply) => {
      const access = accessOf(request);
      if (store === null) return reply.code(409).send(SNAPSHOTS_NEED_STORE);
      if (!Buffer.isBuffer(request.body)) {
        return reply
          .code(415)
          .send(problem("unsupported_media_type", "Send the snapshot as application/gzip."));
      }
      // Sessions can save only the page named in their link.
      const token = bearerToken(request.headers.authorization) ?? "";
      const { path } = request.query;
      if ((await overlaySessionPath(db, token, access.projectId, new Date())) !== path) {
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
