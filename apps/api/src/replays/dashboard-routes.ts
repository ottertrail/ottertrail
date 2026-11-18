import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { Database } from "../db/schema.ts";
import { type ProjectAccess, requireProjectAccess } from "../projects/access.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { deleteProjectReplays, projectReplays, storedReplayBytes } from "./replays.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** Where the dashboard loads the replay player's script from (packages/replay-player). */
export const PLAYER_SCRIPT_URL_PATH = "/replay-player.js";

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

const problem = (error: string, message: string) => ({ error, message });

/**
 * The player page's Content Security Policy. A recording is whatever a
 * browser sent with a public key, which anyone can copy from a site, so it
 * is untrusted HTML: its images, stylesheets, and fonts may come only from
 * the project's allowed hostnames, so a forged recording cannot make the
 * viewer's browser call other servers; scripts only from Ottertrail (the
 * player's own), none from the recording; and only the dashboard may frame
 * the page. Hostnames are checked when saved (projects/projects.ts):
 * letters, digits, dots, and hyphens.
 */
export function playerPolicy(allowedHostnames: readonly string[]): string {
  const sites = allowedHostnames.flatMap((host) => [`https://${host}:*`, `http://${host}:*`]);
  const from = (...sources: string[]) => [...sources, ...sites].join(" ");
  return [
    "default-src 'none'",
    "script-src 'self'",
    "connect-src 'self'",
    // The recording's own stylesheets are written into the page as text.
    `style-src ${from("'self'", "'unsafe-inline'")}`,
    `img-src ${from("'self'", "data:", "blob:")}`,
    `font-src ${from("'self'", "data:")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** The player page: its script, and where to find the replay. Every value is checked first. */
function playerPage(replayUrl: string, errorAt: number | null): string {
  const errorAttribute = errorAt === null ? "" : ` data-error-at="${String(errorAt)}"`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
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
 * GET    /api/projects/:id/replays                         the project's replays, and the instance's use
 * GET    /api/projects/:id/replays/:replayId               one replay: its recording, as JSON
 * GET    /api/projects/:id/replays/:replayId/player        the page that plays it, in a frame of the dashboard
 * DELETE /api/projects/:id/replays                         deletes every replay of the project
 *
 * Session replays in the dashboard (docs/session-replay.md). Like every
 * project route, each runs requireProjectAccess first; deleting also needs
 * the dashboard's origin.
 */
export const replayRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  store: ObjectStore | null;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** Compressed replay bytes the instance may keep. */
  limitBytes: number;
}> = (app, { db, store, auth, trustedOrigins, limitBytes }, done) => {
  const signedIn = requireSession(auth);
  const projectAccess = requireProjectAccess(db);
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
    { preHandler: [signedIn, projectAccess], schema: { params } },
    async (request) => {
      const { projectId } = accessOf(request);
      const [project, replays, stored] = await Promise.all([
        db
          .selectFrom("projects")
          .select("replay_mode")
          .where("id", "=", projectId)
          .executeTakeFirstOrThrow(),
        projectReplays(db, projectId),
        storedReplayBytes(db),
      ]);
      return {
        configured: store !== null,
        mode: project.replay_mode,
        replays,
        instance: { storedBytes: stored, limitBytes },
      };
    },
  );

  app.get<{ Params: { id: string; replayId: string } }>(
    "/projects/:id/replays/:replayId",
    { preHandler: [signedIn, projectAccess], schema: { params: replayParams } },
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
      // Stored gzip-compressed; the browser unpacks it.
      return reply
        .header("content-encoding", "gzip")
        .header("cache-control", "private, max-age=300")
        .header("x-content-type-options", "nosniff")
        .type("application/json")
        .send(Buffer.from(data));
    },
  );

  app.get<{ Params: { id: string; replayId: string }; Querystring: { errorAt?: number } }>(
    "/projects/:id/replays/:replayId/player",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: replayParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { errorAt: { type: "integer", minimum: 0, maximum: 8_640_000_000_000_000 } },
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
          ),
        );
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/projects/:id/replays",
    { preHandler: [fromDashboard, signedIn, projectAccess], schema: { params } },
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

/**
 * GET /replay-player.js: the replay player's script (packages/replay-player),
 * which the player page loads from the dashboard's own origin, read on each
 * request so a new build needs no restart.
 */
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
