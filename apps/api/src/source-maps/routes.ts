import { gunzipSync } from "node:zlib";

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { can, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import { RELEASE_PATTERN } from "../collection/environment.ts";
import { isStorableText } from "../collection/normalize.ts";
import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";
import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import {
  checkSourceMap,
  deleteRelease,
  isSourcePath,
  listFiles,
  listReleases,
  MAX_MAP_LINES,
  MAX_MAP_SEGMENTS,
  MAX_SOURCE_MAP_BYTES,
  MAX_SOURCE_PATH,
  storedBytes,
  storeSourceMap,
} from "./source-maps.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const BEARER = /^Bearer (sk_[0-9a-f]{32})$/;

const problem = (error: string, message: string) => ({ error, message });

const NOT_CONFIGURED = problem(
  "not_configured",
  "This instance has no object store. Source maps are disabled. The instance's operator must set OBJECT_STORE_URL.",
);

function storageUnavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "30")
    .send(problem("storage_unavailable", "The source map could not be stored. Try again."));
}

/** "1 GiB", "512 MiB": a limit as people read it. */
function sizeText(bytes: number): string {
  return bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0
    ? `${bytes / 1024 ** 3} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/**
 * PUT /api/source-maps?release=1.4.2&path=/assets/index-4f3a.js
 *     Authorization: Bearer sk_…   (the body: the map, as JSON; gzip with Content-Encoding)
 *
 * A site's build uploads its source maps (docs/errors.md, "Source maps"),
 * one request per minified file, with the project's secret key: a map
 * holds the site's own source code, so a public key never reaches one.
 * 201 for a new map, 200 for one that replaced the release's earlier map
 * of the same file.
 */
export const sourceMapUploadRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  store: ObjectStore | null;
  projects: ProjectKeyCache;
  /** Compressed bytes the instance may store (Config.sourceMapStorageBytes). */
  limitBytes: number;
  /** Uploads per client address: a build sends one per file, in a burst. */
  ipLimit?: RateLimit;
  /** Uploads this process works on at once: each holds its map in memory. */
  maxInFlight?: number;
}> = (app, { db, store, projects, limitBytes, ipLimit, maxInFlight = 4 }, done) => {
  const ipLimiter = new TokenBucketLimiter(ipLimit ?? { capacity: 200, refillPerSecond: 5 });
  /** The project each upload's key names, found before its body is read. */
  const projectOf = new WeakMap<FastifyRequest, CollectingProject>();
  /** Uploads in progress, each counted once until its answer is sent or it is abandoned. */
  const inFlight = new Set<FastifyRequest>();
  const finished = async (request: FastifyRequest) => {
    inFlight.delete(request);
  };

  // The map as bytes: it is compressed and stored as sent, and a gzip body
  // is unpacked here, with a cap, before anything reads it.
  app.addContentTypeParser(
    ["application/json", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: MAX_SOURCE_MAP_BYTES },
    (_request, body, parsed) => {
      parsed(null, body);
    },
  );

  app.put<{ Querystring: { release: string; path: string }; Body: Buffer | undefined }>(
    "/source-maps",
    {
      bodyLimit: MAX_SOURCE_MAP_BYTES,
      schema: {
        querystring: {
          type: "object",
          required: ["release", "path"],
          additionalProperties: false,
          properties: {
            release: { type: "string", maxLength: 200, pattern: RELEASE_PATTERN },
            path: { type: "string", maxLength: MAX_SOURCE_PATH },
          },
        },
      },
      // Before the body is read, so a request a project would not accept
      // costs no more than its headers: the key's form, the address's rate,
      // the install's store, how busy this process is, and the key itself.
      onRequest: async (request, reply) => {
        const secretKey = BEARER.exec(request.headers.authorization ?? "")?.[1];
        if (secretKey === undefined) {
          return reply
            .code(401)
            .send(
              problem("unauthorized", "Send the project's secret key: Authorization: Bearer sk_…"),
            );
        }
        const result = ipLimiter.take(request.ip);
        if (!result.allowed) {
          return reply
            .code(429)
            .header("retry-after", String(result.retryAfterSeconds))
            .send(problem("rate_limited", "Too many requests from this address."));
        }
        if (store === null) return reply.code(503).send(NOT_CONFIGURED);
        if (inFlight.size >= maxInFlight) {
          return reply
            .code(503)
            .header("retry-after", "2")
            .send(problem("busy", "Too many source maps are being stored. Try again."));
        }
        // Taken before anything waits, so uploads arriving together cannot
        // all pass the check; given back when the answer is sent.
        inFlight.add(request);
        let project;
        try {
          project = await projects.findBySecret(secretKey);
        } catch (error) {
          request.log.error({ err: error }, "could not look up the secret key");
          return storageUnavailable(reply);
        }
        if (project === null) {
          return reply.code(401).send(problem("unknown_key", "No project has this secret key."));
        }
        projectOf.set(request, project);
        return undefined;
      },
      onResponse: finished,
      onRequestAbort: finished,
    },
    async (request, reply) => {
      const project = projectOf.get(request);
      if (store === null || project === undefined) {
        throw new Error("the upload's onRequest hook must find its project first");
      }

      const { release, path } = request.query;
      if (!isSourcePath(path)) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_path",
              `path is the minified file's path as a browser reports it, such as /assets/index-4f3a.js: no origin, query, or fragment, percent-encoded, at most ${MAX_SOURCE_PATH} characters.`,
            ),
          );
      }
      if (!isStorableText(release)) {
        return reply
          .code(400)
          .send(problem("invalid_release", "release contains an unpaired surrogate."));
      }
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_source_map",
              "Send the source map as the body, with Content-Type: application/json.",
            ),
          );
      }

      const encoding = (request.headers["content-encoding"] ?? "identity").toLowerCase();
      let body: Buffer;
      if (encoding === "gzip") {
        try {
          body = gunzipSync(request.body, { maxOutputLength: MAX_SOURCE_MAP_BYTES });
        } catch (error) {
          return error instanceof RangeError
            ? reply
                .code(413)
                .send(
                  problem(
                    "too_large",
                    `A source map has at most ${sizeText(MAX_SOURCE_MAP_BYTES)}.`,
                  ),
                )
            : reply.code(400).send(problem("invalid_gzip", "The body is not valid gzip."));
        }
      } else if (encoding === "identity") {
        body = request.body;
      } else {
        return reply
          .code(415)
          .send(
            problem(
              "unsupported_encoding",
              "Send the map as it is, or with Content-Encoding: gzip.",
            ),
          );
      }

      const text = body.toString("utf8");
      if (checkSourceMap(text) === null) {
        return reply
          .code(400)
          .send(
            problem(
              "invalid_source_map",
              `The body is not a source map Ottertrail reads: JSON with "version": 3, "sources", and "mappings" of base64 VLQ, at most ${MAX_MAP_LINES.toLocaleString("en")} lines and ${MAX_MAP_SEGMENTS.toLocaleString("en")} segments. Index maps ("sections") are not supported.`,
            ),
          );
      }

      let result;
      try {
        result = await storeSourceMap(
          { db, store, limitBytes },
          { id: project.id },
          release,
          path,
          text,
        );
      } catch (error) {
        request.log.error({ err: error }, "could not store a source map");
        return storageUnavailable(reply);
      }
      if ("refused" in result) {
        return result.refused === "no_project"
          ? reply.code(401).send(problem("unknown_key", "No project has this secret key."))
          : reply
              .code(409)
              .send(
                problem(
                  "storage_limit",
                  `The instance's source maps would pass its ${sizeText(limitBytes)} limit. Delete older releases' maps first.`,
                ),
              );
      }
      return reply.code(result.replaced ? 200 : 201).send({ sourceMap: result.stored });
    },
  );

  done();
};

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * GET    /api/projects/:id/source-maps[?order=oldest]     the releases with maps (100, newest or oldest
 *                                                         first, and how many in all), and the instance's use
 * GET    /api/projects/:id/source-maps/files?release=…    one release's files
 * DELETE /api/projects/:id/source-maps?release=…          deletes one release's maps
 *
 * The dashboard's view of a project's maps. Like every project route, each
 * runs requireProjectAccess first; deleting also needs the dashboard's origin.
 */
export const sourceMapRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  store: ObjectStore | null;
  auth: Auth;
  trustedOrigins: readonly string[];
  limitBytes: number;
}> = (app, { db, store, auth, trustedOrigins, limitBytes }, done) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "errors", level: "view" });
  const canManage = requireProjectAccess(db, { area: "errors", level: "manage" });
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const params = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: UUID_PATTERN } },
  };
  const releaseQuery = {
    type: "object",
    required: ["release"],
    additionalProperties: false,
    properties: { release: { type: "string", maxLength: 200, pattern: RELEASE_PATTERN } },
  };

  app.get<{ Params: { id: string }; Querystring: { order?: "newest" | "oldest" } }>(
    "/projects/:id/source-maps",
    {
      preHandler: [signedIn, canView],
      schema: {
        params,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { order: { type: "string", enum: ["newest", "oldest"] } },
        },
      },
    },
    async (request) => {
      const { projectId, user } = accessOf(request);
      const order = request.query.order ?? "newest";
      // All projects together: for those who manage projects only (docs/access.md).
      const showInstance = can(user, "projects");
      const [listed, stored] = await Promise.all([
        listReleases(db, projectId, { order }),
        showInstance ? storedBytes(db) : Promise.resolve(0),
      ]);
      return {
        configured: store !== null,
        ...(showInstance ? { instance: { storedBytes: stored, limitBytes } } : {}),
        order,
        releases: listed.releases,
        totalReleases: listed.total,
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { release: string } }>(
    "/projects/:id/source-maps/files",
    { preHandler: [signedIn, canView], schema: { params, querystring: releaseQuery } },
    async (request) => ({
      release: request.query.release,
      files: await listFiles(db, accessOf(request).projectId, request.query.release),
    }),
  );

  app.delete<{ Params: { id: string }; Querystring: { release: string } }>(
    "/projects/:id/source-maps",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      schema: { params, querystring: releaseQuery },
    },
    async (request, reply) => {
      if (store === null) return reply.code(503).send(NOT_CONFIGURED);
      let deleted;
      try {
        deleted = await deleteRelease(
          { db, store },
          accessOf(request).projectId,
          request.query.release,
        );
      } catch (error) {
        request.log.error({ err: error }, "could not delete source maps");
        return reply
          .code(503)
          .header("retry-after", "30")
          .send(problem("storage_unavailable", "The source maps could not be deleted. Try again."));
      }
      return deleted === 0
        ? reply
            .code(404)
            .send(problem("no_source_maps", "The project has no source maps for this release."))
        : reply.code(204).send();
    },
  );

  done();
};
