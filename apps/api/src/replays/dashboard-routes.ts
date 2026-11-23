import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { can, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import { DEFAULT_ENVIRONMENT, environmentOf } from "../collection/environment.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import type { Database } from "../db/schema.ts";
import { FINGERPRINT_PATTERN } from "../errors/fingerprint.ts";
import { localDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  listReplays,
  MAX_REPLAYS_PAGE_SIZE,
  REPLAY_CURSOR_PATTERN,
  replayChoices,
  replayCursorOf,
  replayTimeline,
} from "./list.ts";
import { deleteProjectReplays, projectReplays, storedReplayBytes } from "./replays.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** Built by packages/replay-player. */
export const PLAYER_SCRIPT_URL_PATH = "/replay-player.js";

/** All routes run requireProjectAccess before this. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

const problem = (error: string, message: string) => ({ error, message });

const FILTER_TEXT_PATTERN = "^[^\\u0000-\\u001F\\u007F]{1,200}$";
/** Milliseconds; well above replay lengths. */
const MAX_MIN_DURATION_MS = 3_600_000;

interface ListQuery extends RangeQuery {
  path?: string;
  userId?: string;
  fingerprint?: string;
  minDuration?: number;
  before?: string;
  limit?: number;
}

/**
 * Recordings and saved heatmap views contain untrusted HTML. Allow only the player script and API
 * connections from self. Permit inline styles and allowed project hosts for styles, images, and
 * fonts; data/blob images support rrweb's cursor. Block forms, base URLs, and framing outside the
 * dashboard.
 *
 * Never allow self for styles, images, or fonts: forged /api/ URLs would send the viewer's
 * cookies. projects/projects.ts validates hostnames as letters, digits, dots, and hyphens.
 */
export function playerPolicy(allowedHostnames: readonly string[]): string {
  const sites = allowedHostnames.flatMap((host) => [`https://${host}:*`, `http://${host}:*`]);
  const from = (...sources: string[]) => [...sources, ...sites].join(" ");
  return [
    "default-src 'none'",
    "script-src 'self'",
    "connect-src 'self'",
    `style-src ${from("'unsafe-inline'")}`,
    `img-src ${from("data:", "blob:")}`,
    `font-src ${from("data:")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** Defaults to dark, matching packages/replay-player/src/styles.ts. */
type PlayerTheme = "light" | "dark";

/** All interpolated values must be validated first. */
function playerPage(replayUrl: string, errorAt: number | null, theme: PlayerTheme): string {
  const errorAttribute = errorAt === null ? "" : ` data-error-at="${String(errorAt)}"`;
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="${theme}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Session replay</title>
    <script src="${PLAYER_SCRIPT_URL_PATH}" defer></script>
  </head>
  <body data-replay-url="${replayUrl}"${errorAttribute}></body>
</html>
`;
}

/**
 * Dashboard replay routes (docs/session-replay.md). All require project access; deletion also
 * checks dashboard Origin.
 */
export const replayRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  store: ObjectStore | null;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** Compressed bytes across the instance. */
  limitBytes: number;
  now?: () => Date;
}> = (app, { db, store, auth, trustedOrigins, limitBytes, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "replays", level: "view" });
  // Deleting all replays requires project-settings access.
  const canManageProject = requireProjectAccess(db, { permission: "projects" });
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const params = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: UUID_PATTERN } },
  };
  const replayParams = {
    type: "object",
    required: ["id", "replayId"],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN },
      replayId: { type: "string", pattern: UUID_PATTERN },
    },
  };
  const NOT_FOUND = problem("replay_not_found", "The project has no replay with this ID.");

  app.get<{ Params: { id: string } }>(
    "/projects/:id/replays",
    { preHandler: [signedIn, canView], schema: { params } },
    async (request) => {
      const { projectId } = accessOf(request);
      const [project, replays, stored] = await Promise.all([
        db
          .selectFrom("projects")
          .select("replay_mode")
          .where("id", "=", projectId)
          .executeTakeFirstOrThrow(),
        projectReplays(db, projectId),
        can(accessOf(request).user, "projects") ? storedReplayBytes(db) : Promise.resolve(0),
      ]);
      return {
        configured: store !== null,
        mode: project.replay_mode,
        replays,
        // Instance totals require project-management permission (docs/access.md).
        ...(can(accessOf(request).user, "projects")
          ? { instance: { storedBytes: stored, limitBytes } }
          : {}),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: ListQuery }>(
    "/projects/:id/replays/list",
    {
      preHandler: [signedIn, canView],
      schema: {
        params,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            path: { type: "string", maxLength: 200, pattern: FILTER_TEXT_PATTERN },
            userId: { type: "string", maxLength: 200, pattern: USER_ID_PATTERN },
            fingerprint: { type: "string", pattern: FINGERPRINT_PATTERN },
            minDuration: { type: "integer", minimum: 0, maximum: MAX_MIN_DURATION_MS },
            before: { type: "string", pattern: REPLAY_CURSOR_PATTERN },
            limit: { type: "integer", minimum: 1, maximum: MAX_REPLAYS_PAGE_SIZE },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const { query } = request;
      const days = requestDays(query, dayIn(timeZone)(now()));
      if ("problem" in days) return reply.code(400).send(days.problem);
      const before = query.before === undefined ? undefined : replayCursorOf(query.before);
      if (before === null) {
        return reply
          .code(400)
          .send(problem("invalid_query", "before is not a cursor of this list."));
      }
      const { from, to } = await localDays(db, days.from, days.to, timeZone);
      const environment = environmentOf(query.environment);
      const [page, choices] = await Promise.all([
        listReplays(
          db,
          projectId,
          {
            from,
            to,
            environment,
            path: query.path,
            userId: query.userId,
            fingerprint: query.fingerprint,
            minDurationMs: query.minDuration,
          },
          { before, ...(query.limit === undefined ? {} : { limit: query.limit }) },
        ),
        // Load filter choices only on the first page.
        before === undefined ? replayChoices(db, projectId, { from, to }, environment) : null,
      ]);
      const environments = choices?.environments ?? [];
      for (const name of [environment, DEFAULT_ENVIRONMENT]) {
        if (choices !== null && !environments.includes(name)) environments.push(name);
      }
      return {
        configured: store !== null,
        timeZone,
        environment,
        environments,
        errorGroups: choices?.errorGroups ?? [],
        firstDay: days.from,
        lastDay: days.to,
        ...page,
      };
    },
  );

  app.get<{ Params: { id: string; replayId: string } }>(
    "/projects/:id/replays/:replayId/timeline",
    { preHandler: [signedIn, canView], schema: { params: replayParams } },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const found = await replayTimeline(db, projectId, request.params.replayId.toLowerCase());
      if (found === null) return reply.code(404).send(NOT_FOUND);
      return { timeZone, ...found };
    },
  );

  app.get<{ Params: { id: string; replayId: string } }>(
    "/projects/:id/replays/:replayId",
    { preHandler: [signedIn, canView], schema: { params: replayParams } },
    async (request, reply) => {
      if (store === null) return reply.code(404).send(NOT_FOUND);
      const row = await db
        .selectFrom("replays")
        .select("object_key")
        .where("project_id", "=", accessOf(request).projectId)
        .where("replay_id", "=", request.params.replayId.toLowerCase())
        .executeTakeFirst();
      if (row === undefined) return reply.code(404).send(NOT_FOUND);
      let data;
      try {
        data = await store.get(row.object_key);
      } catch (error) {
        request.log.error({ err: error }, "could not read a replay");
        return reply
          .code(503)
          .header("retry-after", "30")
          .send(problem("storage_unavailable", "The replay could not be read. Try again."));
      }
      if (data === null) return reply.code(404).send(NOT_FOUND);
      // Browser decompresses the stored gzip.
      return reply
        .header("content-encoding", "gzip")
        .header("cache-control", "private, max-age=300")
        .header("x-content-type-options", "nosniff")
        .type("application/json")
        .send(Buffer.from(data));
    },
  );

  app.get<{
    Params: { id: string; replayId: string };
    Querystring: { errorAt?: number; theme?: PlayerTheme };
  }>(
    "/projects/:id/replays/:replayId/player",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: replayParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            errorAt: { type: "integer", minimum: 0, maximum: 8_640_000_000_000_000 },
            theme: { type: "string", enum: ["light", "dark"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId } = accessOf(request);
      const project = await db
        .selectFrom("projects")
        .select("allowed_hostnames")
        .where("id", "=", projectId)
        .executeTakeFirstOrThrow();
      const replayId = request.params.replayId.toLowerCase();
      return reply
        .header("content-security-policy", playerPolicy(project.allowed_hostnames))
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .type("text/html; charset=utf-8")
        .send(
          playerPage(
            `/api/projects/${projectId}/replays/${replayId}`,
            request.query.errorAt ?? null,
            request.query.theme ?? "dark",
          ),
        );
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/projects/:id/replays",
    { preHandler: [fromDashboard, signedIn, canManageProject], schema: { params } },
    async (request, reply) => {
      if (store === null) return reply.code(204).send();
      try {
        await deleteProjectReplays(db, store, accessOf(request).projectId);
      } catch (error) {
        request.log.error({ err: error }, "could not delete replays");
        return reply
          .code(503)
          .header("retry-after", "30")
          .send(problem("storage_unavailable", "The replays could not be deleted. Try again."));
      }
      return reply.code(204).send();
    },
  );

  done();
};

/** Read packages/replay-player's script per request so rebuilds need no API restart. */
export const replayPlayerScriptRoute: FastifyPluginCallback<{ scriptPath: string }> = (
  app,
  { scriptPath },
  done,
) => {
  app.get(PLAYER_SCRIPT_URL_PATH, async (request, reply) => {
    let script: Buffer;
    try {
      script = await readFile(scriptPath);
    } catch {
      request.log.error({ scriptPath }, "the replay player is missing; run `vp run -r build`");
      return reply
        .code(503)
        .header("cache-control", "no-store")
        .type("text/plain; charset=utf-8")
        .send("The replay player has not been built on this instance.");
    }
    const etag = `"${createHash("sha256").update(script).digest("base64url").slice(0, 27)}"`;
    reply
      .header("cache-control", "no-cache")
      .header("etag", etag)
      .header("x-content-type-options", "nosniff");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.type("text/javascript; charset=utf-8").send(script);
  });
  done();
};
