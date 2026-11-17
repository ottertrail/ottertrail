import { gunzipSync } from "node:zlib";

import type { FastifyError, FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { isAllowedHostname, originHostname } from "../collection/normalize.ts";
import { ProjectKeyCache, PUBLIC_KEY_PATTERN } from "../collection/project-keys.ts";
import { EventBudget, type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import { type IsDataCenter, noDataCenters } from "../enrichment/data-centers.ts";
import { isBot } from "../enrichment/user-agent.ts";
import { MAX_CHUNK_BYTES, MAX_CHUNK_UNPACKED_BYTES, MAX_CHUNKS, storeChunk } from "./replays.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** Chunks per client address: one replay is a few dozen at most. */
export const DEFAULT_REPLAY_IP_LIMIT: RateLimit = { capacity: 100, refillPerSecond: 2 };
/**
 * Replay bytes, in KiB, per project and per organization, apart from
 * events' budgets, so recordings never crowd events out: bursts of a few
 * replays, and a steady flow of about one 2 MB replay every 8 seconds for a
 * project and 3 for an organization. Provisional, until measured on real
 * sites (docs/session-replay.md, "Decisions still open").
 */
export const DEFAULT_REPLAY_PROJECT_LIMIT: RateLimit = { capacity: 8192, refillPerSecond: 256 };
export const DEFAULT_REPLAY_ORGANIZATION_LIMIT: RateLimit = {
  capacity: 24_576,
  refillPerSecond: 768,
};

const problem = (error: string, message: string) => ({ error, message });

function tooManyRequests(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send(problem("rate_limited", "Too many requests. Try again later."));
}

function storageUnavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "30")
    .send(problem("storage_unavailable", "The replay could not be stored. Try again."));
}

interface ChunkQuery {
  key: string;
  replay: string;
  seq: number;
  last: 0 | 1;
  cut: 0 | 1;
}

/**
 * POST /api/replays?key=pk_…&replay=<uuid>&seq=<n>&last=0|1&cut=0|1
 *
 * A chunk of a session replay (docs/session-replay.md), as the tracker's
 * recorder sends it: one gzip member of a piece of the recording's JSON,
 * as text/plain, so a page sends it without a preflight, and with a beacon
 * when it is closing. Checked as events are, cheapest first: the address's
 * rate, the body's size, the public key, the page's origin against the
 * project's allowed hostnames, the project's replay setting, bots, and its
 * own budgets in bytes. 202 once PostgreSQL has it; the worker joins a
 * replay's chunks (replays.ts).
 */
export const replayCollectionRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  projects: ProjectKeyCache;
  /** Compressed replay bytes each organization may keep (Config.replayBytesPerOrganization). */
  limitBytes: number;
  /** Whether the install has an object store to keep replays in: without one, they are off. */
  storeConfigured: boolean;
  ipLimit?: RateLimit;
  projectLimit?: RateLimit;
  organizationLimit?: RateLimit;
  isDataCenter?: IsDataCenter;
  now?: () => number;
}> = (app, options, done) => {
  const {
    db,
    projects,
    limitBytes,
    storeConfigured,
    isDataCenter = noDataCenters,
    now = Date.now,
  } = options;
  const ipLimiter = new TokenBucketLimiter(options.ipLimit ?? DEFAULT_REPLAY_IP_LIMIT, { now });
  // In KiB: a chunk costs its size.
  const budget = new EventBudget(
    new TokenBucketLimiter(options.projectLimit ?? DEFAULT_REPLAY_PROJECT_LIMIT, { now }),
    new TokenBucketLimiter(options.organizationLimit ?? DEFAULT_REPLAY_ORGANIZATION_LIMIT, {
      now,
    }),
  );

  // The chunk as bytes: gzip, kept as sent.
  app.addContentTypeParser(
    ["text/plain", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: MAX_CHUNK_BYTES },
    (_request, body, parsed) => {
      parsed(null, body);
    },
  );

  // As for events: the page may read every answer, so the recorder knows
  // whether trying again can help (collection/routes.ts).
  app.addHook("onSend", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      reply
        .header("access-control-allow-origin", origin)
        .header("access-control-expose-headers", "Retry-After")
        .header("vary", "Origin");
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation !== undefined || error.statusCode === 400) {
      return reply.code(400).send(problem("invalid_request", error.message));
    }
    if (error.statusCode === 413) {
      return reply
        .code(413)
        .send(problem("payload_too_large", `A chunk is at most ${MAX_CHUNK_BYTES} bytes.`));
    }
    if (error.statusCode === 415) {
      return reply
        .code(415)
        .send(problem("unsupported_media_type", "Send the chunk as text/plain."));
    }
    request.log.error({ err: error }, "unexpected error while collecting a replay");
    return reply.code(500).send(problem("internal_error", "Something went wrong."));
  });

  app.post<{ Querystring: ChunkQuery; Body: Buffer | undefined }>(
    "/replays",
    {
      bodyLimit: MAX_CHUNK_BYTES,
      schema: {
        querystring: {
          type: "object",
          required: ["key", "replay", "seq", "last", "cut"],
          additionalProperties: false,
          properties: {
            key: { type: "string", pattern: PUBLIC_KEY_PATTERN },
            replay: { type: "string", pattern: UUID_PATTERN },
            seq: { type: "integer", minimum: 0, maximum: MAX_CHUNKS - 1 },
            last: { type: "integer", enum: [0, 1] },
            cut: { type: "integer", enum: [0, 1] },
          },
        },
      },
      // Before the body is read: the cheapest way to turn a flood away.
      onRequest: async (request, reply) => {
        const result = ipLimiter.take(request.ip);
        return result.allowed ? undefined : tooManyRequests(reply, result.retryAfterSeconds);
      },
    },
    async (request, reply) => {
      const { key, replay, seq, last, cut } = request.query;
      let project;
      try {
        project = await projects.find(key);
      } catch (error) {
        request.log.error({ err: error }, "could not look up the project key");
        return storageUnavailable(reply);
      }
      if (project === null) {
        return reply.code(403).send(problem("unknown_key", "No project has this key."));
      }
      const origin = request.headers.origin;
      if (origin !== undefined) {
        const hostname = originHostname(origin);
        if (hostname === null || !isAllowedHostname(hostname, project.allowedHostnames)) {
          return reply
            .code(403)
            .send(problem("origin_not_allowed", "This site may not send to this project."));
        }
      }
      // "replay_off" stops the page's recorder for the rest of its load.
      if (project.replayMode !== "errors") {
        return reply
          .code(403)
          .send(problem("replay_off", "The project does not take session replays."));
      }
      if (!storeConfigured) {
        return reply
          .code(403)
          .send(
            problem("replay_off", "This install has no object store, so session replays are off."),
          );
      }
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        return reply.code(400).send(problem("invalid_request", "Send the chunk as the body."));
      }
      try {
        gunzipSync(request.body, { maxOutputLength: MAX_CHUNK_UNPACKED_BYTES });
      } catch (error) {
        return error instanceof RangeError
          ? reply.code(413).send(problem("payload_too_large", "A chunk unpacks to at most 1 MiB."))
          : reply.code(400).send(problem("invalid_request", "The chunk is not gzip."));
      }
      // Accepted and ignored, as their events are (collection/routes.ts).
      if (
        isBot(request.headers["user-agent"]) ||
        (project.ignoreDataCenters && isDataCenter(request.ip))
      ) {
        return reply.code(202).send({ stored: 0 });
      }
      const spent = budget.take(project, Math.ceil(request.body.byteLength / 1024));
      if (!spent.allowed) return tooManyRequests(reply, spent.retryAfterSeconds);

      let result;
      try {
        result = await storeChunk(
          db,
          project,
          {
            replayId: replay.toLowerCase(),
            seq,
            last: last === 1,
            cut: cut === 1,
            data: request.body,
          },
          limitBytes,
        );
      } catch (error) {
        request.log.error({ err: error }, "could not store a replay chunk");
        return storageUnavailable(reply);
      }
      switch (result) {
        case "storage_full":
          return reply
            .code(403)
            .send(
              problem(
                "replay_storage_full",
                "The organization's replays have reached their storage limit.",
              ),
            );
        case "too_large":
          return reply
            .code(413)
            .send(problem("replay_too_large", "A replay is at most 2 MB, compressed."));
        default:
          return reply.code(202).send({ stored: result === "stored" ? 1 : 0 });
      }
    },
  );

  done();
};
