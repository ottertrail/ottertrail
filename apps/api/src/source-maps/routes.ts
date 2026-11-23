import { gunzipSync } from "node:zlib";

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import { can, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { IngestActivity, IngestOutcome } from "../activity/activity.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import { RELEASE_PATTERN } from "../collection/environment.ts";
import { InFlight } from "../collection/in-flight.ts";
import { isStorableText } from "../collection/normalize.ts";
import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";
import { clientKey, type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import {
  checkSourceMap,
  deleteRelease,
  isSourcePath,
  listFiles,
  listReleases,
  MAX_MAP_ENTRY,
  MAX_MAP_LINES,
  MAX_MAP_NAMES,
  MAX_MAP_SEGMENTS,
  MAX_MAP_SOURCES,
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

function sizeText(bytes: number): string {
  return bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0
    ? `${bytes / 1024 ** 3} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/**
 * Source maps contain application source, so uploads require secret project keys (docs/errors.md,
 * "Source maps"). Returns 201 for new files and 200 for replacements.
 */
export const sourceMapUploadRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  store: ObjectStore | null;
  projects: ProjectKeyCache;
  /** Activity tab counts (activity/activity.ts). */
  activity: IngestActivity;
  /** Compressed instance quota (Config.sourceMapStorageBytes). */
  limitBytes: number;
  /** Allows builds to burst one upload per file. */
  ipLimit?: RateLimit;
  /** Bounds maps held in memory per process. */
  maxInFlight?: number;
  /** Prevents one project's slow uploads from occupying every slot. */
  maxInFlightPerProject?: number;
}> = (app, options, done) => {
  const { db, store, projects, activity, limitBytes, ipLimit } = options;
  const ipLimiter = new TokenBucketLimiter(ipLimit ?? { capacity: 200, refillPerSecond: 5 });
  /** Resolve before reading bodies. */
  const projectOf = new WeakMap<FastifyRequest, CollectingProject>();
  const inFlight = new InFlight(options.maxInFlight ?? 4, options.maxInFlightPerProject ?? 2);
  /** Counts only uploads whose project is known (activity/activity.ts). */
  const count = (request: FastifyRequest, outcome: IngestOutcome, items = 0) => {
    const project = projectOf.get(request);
    if (project !== undefined) activity.add(project.id, "source_maps", outcome, items);
  };

  // Preserve uploaded bytes for storage; cap gzip decompression before reading content.
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
      // Reject key, rate, store, and concurrency failures before reading bodies to limit cost to
      // headers.
      onRequest: async (request, reply) => {
        const secretKey = BEARER.exec(request.headers.authorization ?? "")?.[1];
        if (secretKey === undefined) {
          return reply
            .code(401)
            .send(
              problem("unauthorized", "Send the project's secret key: Authorization: Bearer sk_…"),
            );
        }
        const result = ipLimiter.take(clientKey(request.ip));
        if (!result.allowed) {
          return reply
            .code(429)
            .header("retry-after", String(result.retryAfterSeconds))
            .send(problem("rate_limited", "Too many requests from this address."));
        }
        if (store === null) return reply.code(503).send(NOT_CONFIGURED);
        if (!inFlight.take(request, reply)) {
          return reply
            .code(503)
            .header("retry-after", "2")
            .send(problem("busy", "Too many source maps are being stored. Try again."));
        }
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
        if (!inFlight.takeForProject(request, project.id)) {
          activity.add(project.id, "source_maps", "refused_rate_limited", 0);
          return reply
            .code(429)
            .header("retry-after", "2")
            .send(
              problem(
                "busy",
                "Too many of this project's source maps are being stored. Send fewer at once.",
              ),
            );
        }
        projectOf.set(request, project);
        return undefined;
      },
      onResponse: inFlight.finished,
      onRequestAbort: inFlight.finished,
      // Keys resolve before body/query parsing, so Fastify refusals count against the project.
      onError: async (request, _reply, error) => {
        const status = error.validation === undefined ? (error.statusCode ?? 500) : 400;
        if (status >= 400 && status < 500) count(request, "refused_invalid");
      },
    },
    // Hold the slot through storage.
    async (request, reply) =>
      inFlight.run(request, async () => {
        const project = projectOf.get(request);
        if (store === null || project === undefined) {
          throw new Error("the upload's onRequest hook must find its project first");
        }

        const { release, path } = request.query;
        if (!isSourcePath(path)) {
          count(request, "refused_invalid");
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
          count(request, "refused_invalid");
          return reply
            .code(400)
            .send(problem("invalid_release", "release contains an unpaired surrogate."));
        }
        if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
          count(request, "refused_invalid");
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
            count(request, "refused_invalid");
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
          count(request, "refused_invalid");
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
          count(request, "refused_invalid");
          return reply
            .code(400)
            .send(
              problem(
                "invalid_source_map",
                `The body is not a source map Ottertrail reads: JSON with "version": 3, "sources", and "mappings" of base64 VLQ, at most ${MAX_MAP_LINES.toLocaleString("en")} lines, ${MAX_MAP_SEGMENTS.toLocaleString("en")} segments, ${MAX_MAP_SOURCES.toLocaleString("en")} sources, and ${MAX_MAP_NAMES.toLocaleString("en")} names of up to ${MAX_MAP_ENTRY.toLocaleString("en")} characters each, and "sourcesContent" of text, one per source at most. Index maps ("sections") are not supported.`,
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
          count(request, "refused_unavailable");
          return storageUnavailable(reply);
        }
        // Deleted projects have no counters to update.
        if ("refused" in result && result.refused !== "no_project")
          count(request, "refused_volume");
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
        count(request, "accepted", 1);
        return reply.code(result.replaced ? 200 : 201).send({ sourceMap: result.stored });
      }),
  );

  done();
};

/** All routes run requireProjectAccess before this. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/** Dashboard maps require project access; deletions also check dashboard Origin. */
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
      // Instance totals require project-management permission (docs/access.md).
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
