import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import { mintOverlayLink } from "../access/overlay-tokens.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { HEATMAP_RETENTION_DAYS } from "../clickhouse/migrations.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import { isStorableText } from "../collection/normalize.ts";
import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { dashboardReader, type DashboardQueryLimiter } from "../telemetry/dashboard-limit.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  emptyReport,
  heatmapEnvironments,
  heatmapPages,
  type HeatmapRange,
  heatmapReport,
} from "./report.ts";
import { DEVICES, type HeatmapDevice } from "./store.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const PARAMS_SCHEMA = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;
/** Matches collection paths: a leading "/", up to 2,048 characters. */
const PATH_SCHEMA = { type: "string", minLength: 1, maxLength: 2048, pattern: "^/" } as const;

export type Query = RangeQuery & { device?: HeatmapDevice };

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Returns null for no body, undefined for an invalid `{ path }`. */
function linkPathOf(body: unknown): string | null | undefined {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length === 0) return null;
  const path: unknown = "path" in body ? body.path : undefined;
  return keys.length === 1 &&
    typeof path === "string" &&
    path.startsWith("/") &&
    path.length <= 2048 &&
    isStorableText(path)
    ? path
    : undefined;
}

/** Overlay links each user may make: 20 at once, then 20 a minute. */
export const DEFAULT_OVERLAY_MINT_LIMIT: RateLimit = { capacity: 20, refillPerSecond: 20 / 60 };

/** The requested range clipped to retention, with response metadata. */
export type AskedRange =
  | { problem: { error: string; message: string } }
  | {
      range: HeatmapRange;
      /** The range is wholly before the 90 days kept: nothing to read. */
      before: boolean;
      answer: {
        timeZone: string;
        environment: string;
        firstDay: string;
        lastDay: string;
        heatmaps: boolean;
        retentionDays: number;
        clipped: boolean;
        device: HeatmapDevice | null;
        /** Allowed site hostnames where the dashboard can open the overlay. */
        siteHostnames: string[];
      };
    };

/** Clips reports to the 90 days kept and reads the heatmap setting (overlay-routes.ts). */
export async function heatmapRangeOf(
  db: Kysely<Database>,
  { projectId, timeZone }: ProjectAccess,
  query: Query,
  now: Date,
): Promise<AskedRange> {
  const today = dayIn(timeZone)(now);
  const days = requestDays(query, today);
  if ("problem" in days) return days;
  const firstKept = addDays(today, -(HEATMAP_RETENTION_DAYS - 1));
  const clipped = days.from < firstKept;
  // Keep an expired range unchanged; routes return empty reports.
  const before = days.to < firstKept;
  const firstDay = clipped && !before ? firstKept : days.from;
  const lastDay = days.to;
  const [{ from, to }, project] = await Promise.all([
    localDays(db, firstDay, lastDay, timeZone),
    db
      .selectFrom("projects")
      .select(["heatmaps", "allowed_hostnames"])
      .where("id", "=", projectId)
      .executeTakeFirst(),
  ]);
  const environment = environmentOf(query.environment);
  return {
    range: { projectId, environment, from, to, device: query.device },
    before,
    answer: {
      timeZone,
      environment,
      firstDay,
      lastDay,
      heatmaps: project?.heatmaps ?? false,
      retentionDays: HEATMAP_RETENTION_DAYS,
      clipped,
      device: query.device ?? null,
      siteHostnames: project?.allowed_hostnames ?? [],
    },
  };
}

/**
 * Heatmap reports use the dashboard query limits (telemetry/dashboard-limit.ts).
 * Ranges are clipped to the 90 days kept (docs/web-analytics.md, "Heatmaps").
 * Overlay links are one-time tokens minted from the dashboard origin, up to
 * 20 per minute per user (access/overlay-tokens.ts; docs/web-analytics.md,
 * "The overlay on your site").
 */
export const heatmapRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  limiter: DashboardQueryLimiter;
  trustedOrigins: readonly string[];
  mintLimit?: RateLimit;
  now?: () => Date;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    limiter,
    trustedOrigins,
    mintLimit = DEFAULT_OVERLAY_MINT_LIMIT,
    now = () => new Date(),
  },
  done,
) => {
  const mintLimiter = new TokenBucketLimiter(mintLimit);
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const canView = requireProjectAccess(db, { area: "web_analytics", level: "view" });
  app.setErrorHandler(clickHouseErrorHandler);

  const readerOf = (reply: FastifyReply): Reader => ({
    ...dashboardReader(clickhouse, limiter, reply),
    settings: DASHBOARD_SETTINGS,
  });

  const rangeOf = (request: { projectAccess: ProjectAccess | null; query: Query }) =>
    heatmapRangeOf(db, accessOf(request), request.query, now());

  const queryProperties = {
    ...RANGE_PROPERTIES,
    device: { type: "string", enum: DEVICES },
  };

  app.get<{ Params: { id: string }; Querystring: Query & { search?: string } }>(
    "/projects/:id/heatmaps/pages",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { ...queryProperties, search: { type: "string", maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      if (asked.before) {
        return { ...asked.answer, environments: [asked.answer.environment], pages: [] };
      }
      const reader = readerOf(reply);
      const [environments, pages] = await Promise.all([
        heatmapEnvironments(reader, asked.range),
        heatmapPages(reader, asked.range, request.query.search?.trim()),
      ]);
      return { ...asked.answer, environments, pages };
    },
  );

  app.get<{ Params: { id: string }; Querystring: Query & { path: string } }>(
    "/projects/:id/heatmaps",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS_SCHEMA,
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { ...queryProperties, path: PATH_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      if (asked.before) {
        return {
          ...asked.answer,
          environments: [asked.answer.environment],
          path: request.query.path,
          ...emptyReport(),
        };
      }
      const reader = readerOf(reply);
      const [environments, report] = await Promise.all([
        heatmapEnvironments(reader, asked.range),
        heatmapReport(reader, asked.range, request.query.path),
      ]);
      return { ...asked.answer, environments, path: request.query.path, ...report };
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/projects/:id/heatmaps/overlay-link",
    { preHandler: [fromDashboard, signedIn, canView], schema: { params: PARAMS_SCHEMA } },
    async (request, reply) => {
      // The session may save a view only for the page named in its link.
      const path = linkPathOf(request.body);
      if (path === undefined) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "The body is { path }, a page path starting with /, or empty.",
        });
      }
      const { projectId, user } = accessOf(request);
      const limited = mintLimiter.take(user.userId);
      if (!limited.allowed) {
        return reply
          .code(429)
          .header("retry-after", String(limited.retryAfterSeconds))
          .send({
            error: "rate_limited",
            message: `Too many links. Try again in ${limited.retryAfterSeconds} seconds.`,
          });
      }
      // Use the real clock to match token exchange expiry checks.
      const link = await mintOverlayLink(
        db,
        { userId: user.userId, sessionId: signedInUser(request).sessionId },
        projectId,
        new Date(),
        path,
      );
      return reply
        .header("cache-control", "no-store")
        .send({ token: link.token, expiresAt: link.expiresAt.toISOString() });
    },
  );

  done();
};
