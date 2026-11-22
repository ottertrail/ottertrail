import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import type { Database } from "../db/schema.ts";
import { PLAYER_SCRIPT_URL_PATH, playerPolicy } from "../replays/dashboard-routes.ts";
import { RANGE_PROPERTIES, type RangeQuery } from "../reports/routes.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { dashboardReader, type DashboardQueryLimiter } from "../telemetry/dashboard-limit.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { heatmapRangeOf } from "./dashboard-routes.ts";
import { emptyOverlay, heatmapOverlay } from "./report.ts";
import { deleteSnapshot, listSnapshots, snapshotKey } from "./snapshots.ts";
import { DEVICES, type HeatmapDevice } from "./store.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;
const VIEW_PARAMS = {
  type: "object",
  required: ["id", "device"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    device: { type: "string", enum: DEVICES },
  },
} as const;
/** A page path as collection stores it. */
const PATH = { type: "string", minLength: 1, maxLength: 2048, pattern: "^/" } as const;
const PATH_QUERY = {
  type: "object",
  required: ["path"],
  additionalProperties: false,
  properties: { path: PATH },
} as const;

const problem = (error: string, message: string) => ({ error, message });
const NOT_FOUND = problem("snapshot_not_found", "This page has no saved view for this device.");

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/** The store could not be reached: try again. */
const unavailable = (reply: FastifyReply, what: string) =>
  reply
    .code(503)
    .header("retry-after", "30")
    .send(problem("storage_unavailable", `The saved view could not be ${what}. Try again.`));

/** Text for an HTML attribute: its five special characters escaped. */
const attribute = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** The page that shows a saved view with the heatmap over it: the replay player's script, in its snapshot mode. */
function snapshotPage(snapshotUrl: string, heatmapUrl: string, theme: "light" | "dark"): string {
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="${theme}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Saved heatmap view</title>
    <script src="${PLAYER_SCRIPT_URL_PATH}" defer></script>
  </head>
  <body data-snapshot-url="${attribute(snapshotUrl)}" data-heatmap-url="${attribute(heatmapUrl)}"></body>
</html>
`;
}

type ViewQuery = RangeQuery & { path: string };

/**
 * Saved heatmap views in the dashboard (heatmaps/snapshots.ts;
 * docs/dashboard.md, "Heatmaps"), in the Web analytics area at view, as
 * the overlay that saves them is:
 *
 *   GET    /api/projects/:id/heatmaps/snapshots?path=/pricing           the page's saved views
 *   GET    /api/projects/:id/heatmaps/snapshots/:device?path=…          one, as JSON (gzip)
 *   GET    /api/projects/:id/heatmaps/snapshots/:device/player?path=…&period=…&environment=…&theme=…
 *                                                                       the page that shows it, in a frame of the dashboard
 *   GET    /api/projects/:id/heatmaps/snapshots/:device/heatmap?path=…&period=…&environment=…
 *                                                                       the heatmap it draws: the overlay's answer, for the dashboard's range
 *   DELETE /api/projects/:id/heatmaps/snapshots/:device?path=…          deletes it (from the dashboard's origin)
 *
 * The player page is the replay player's (packages/replay-player), with
 * its Content Security Policy: a snapshot is untrusted HTML as a replay
 * is, shown only in rrweb's sandboxed frame.
 */
export const heatmapSnapshotRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  store: ObjectStore | null;
  auth: Auth;
  limiter: DashboardQueryLimiter;
  trustedOrigins: readonly string[];
  now?: () => Date;
}> = (
  app,
  { db, clickhouse, store, auth, limiter, trustedOrigins, now = () => new Date() },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "web_analytics", level: "view" });
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  app.setErrorHandler(clickHouseErrorHandler);

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/projects/:id/heatmaps/snapshots",
    { preHandler: [signedIn, canView], schema: { params: PARAMS, querystring: PATH_QUERY } },
    async (request) => ({
      configured: store !== null,
      snapshots:
        store === null
          ? []
          : await listSnapshots(db, accessOf(request).projectId, request.query.path),
    }),
  );

  app.get<{ Params: { id: string; device: HeatmapDevice }; Querystring: { path: string } }>(
    "/projects/:id/heatmaps/snapshots/:device",
    { preHandler: [signedIn, canView], schema: { params: VIEW_PARAMS, querystring: PATH_QUERY } },
    async (request, reply) => {
      if (store === null) return reply.code(404).send(NOT_FOUND);
      const { projectId } = accessOf(request);
      const key = await snapshotKey(db, projectId, request.query.path, request.params.device);
      if (key === null) return reply.code(404).send(NOT_FOUND);
      let data;
      try {
        data = await store.get(key);
      } catch (error) {
        request.log.error({ err: error }, "could not read a heatmap snapshot");
        return unavailable(reply, "read");
      }
      if (data === null) return reply.code(404).send(NOT_FOUND);
      // Stored gzip-compressed, as sent; the browser unpacks it.
      return reply
        .header("content-encoding", "gzip")
        .header("cache-control", "private, no-cache")
        .header("x-content-type-options", "nosniff")
        .type("application/json")
        .send(Buffer.from(data));
    },
  );

  const viewQuery = {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: { ...RANGE_PROPERTIES, path: PATH },
  } as const;

  app.get<{
    Params: { id: string; device: HeatmapDevice };
    Querystring: ViewQuery & { theme?: "light" | "dark" };
  }>(
    "/projects/:id/heatmaps/snapshots/:device/player",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: VIEW_PARAMS,
        querystring: {
          ...viewQuery,
          properties: {
            ...viewQuery.properties,
            theme: { type: "string", enum: ["light", "dark"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId } = accessOf(request);
      const { device } = request.params;
      const { theme, ...rest } = request.query;
      const project = await db
        .selectFrom("projects")
        .select("allowed_hostnames")
        .where("id", "=", projectId)
        .executeTakeFirstOrThrow();
      const base = `/api/projects/${projectId}/heatmaps/snapshots/${device}`;
      const range = new URLSearchParams(
        Object.entries(rest).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      return reply
        .header("content-security-policy", playerPolicy(project.allowed_hostnames))
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .type("text/html; charset=utf-8")
        .send(
          snapshotPage(
            `${base}?${new URLSearchParams({ path: rest.path }).toString()}`,
            `${base}/heatmap?${range.toString()}`,
            theme ?? "dark",
          ),
        );
    },
  );

  app.get<{ Params: { id: string; device: HeatmapDevice }; Querystring: ViewQuery }>(
    "/projects/:id/heatmaps/snapshots/:device/heatmap",
    { preHandler: [signedIn, canView], schema: { params: VIEW_PARAMS, querystring: viewQuery } },
    async (request, reply) => {
      const { device } = request.params;
      const { path, ...range } = request.query;
      const asked = await heatmapRangeOf(db, accessOf(request), { ...range, device }, now());
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { firstDay, lastDay, clipped, environment } = asked.answer;
      const head = { path, device, environment, firstDay, lastDay, clipped };
      if (asked.before) return { ...head, ...emptyOverlay() };
      const reader = {
        ...dashboardReader(clickhouse, limiter, reply),
        settings: DASHBOARD_SETTINGS,
      };
      return { ...head, ...(await heatmapOverlay(reader, { ...asked.range, device }, path)) };
    },
  );

  app.delete<{ Params: { id: string; device: HeatmapDevice }; Querystring: { path: string } }>(
    "/projects/:id/heatmaps/snapshots/:device",
    {
      preHandler: [fromDashboard, signedIn, canView],
      schema: { params: VIEW_PARAMS, querystring: PATH_QUERY },
    },
    async (request, reply) => {
      if (store === null) return reply.code(404).send(NOT_FOUND);
      let deleted;
      try {
        deleted = await deleteSnapshot(
          db,
          store,
          accessOf(request).projectId,
          request.query.path,
          request.params.device,
        );
      } catch (error) {
        request.log.error({ err: error }, "could not delete a heatmap snapshot");
        return unavailable(reply, "deleted");
      }
      return deleted ? reply.code(204).send() : reply.code(404).send(NOT_FOUND);
    },
  );

  done();
};
