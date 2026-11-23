import { gunzipSync } from "node:zlib";

import type { FastifyError, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { IngestActivity, IngestOutcome } from "../activity/activity.ts";
import { InFlight } from "../collection/in-flight.ts";
import { isAllowedHostname, originHostname } from "../collection/normalize.ts";
import {
  type CollectingProject,
  ProjectKeyCache,
  PUBLIC_KEY_PATTERN,
} from "../collection/project-keys.ts";
import {
  clientKey,
  EventBudget,
  type RateLimit,
  TokenBucketLimiter,
} from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import { type IsDataCenter, noDataCenters } from "../enrichment/data-centers.ts";
import { isBot } from "../enrichment/user-agent.ts";
import { isBlockedAddress } from "../projects/blocked-addresses.ts";
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNK_UNPACKED_BYTES,
  MAX_CHUNKS,
  MAX_REPLAY_UNPACKED_BYTES,
  storeChunk,
} from "./replays.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** One replay usually needs at most a few dozen chunks. */
export const DEFAULT_REPLAY_IP_LIMIT: RateLimit = { capacity: 100, refillPerSecond: 2 };
/**
 * Separate KiB budgets protect event ingestion. Allows about one 2 MB replay per 8 seconds per
 * project, three for the instance. Provisional (docs/session-replay.md, "Decisions still open").
 */
export const DEFAULT_REPLAY_PROJECT_LIMIT: RateLimit = { capacity: 8192, refillPerSecond: 256 };
export const DEFAULT_REPLAY_INSTANCE_LIMIT: RateLimit = {
  capacity: 24_576,
  refillPerSecond: 768,
};
/**
 * Count slots after body arrival through storage: each holds at most 64 KB compressed and 1 MiB
 * unpacked. Allow over 100 chunks per project because leaving-page beacons send all chunks without
 * retries.
 */
export const DEFAULT_REPLAY_MAX_IN_FLIGHT = 256;
export const DEFAULT_REPLAY_MAX_IN_FLIGHT_PER_PROJECT = 128;
const KEY = new RegExp(PUBLIC_KEY_PATTERN);

const problem = (error: string, message: string) => ({ error, message });
/**
 * Same acknowledgment for stored, duplicate, and filtered chunks so senders cannot distinguish
 * them.
 */
const RECEIVED = { received: 1 } as const;

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
 * text/plain gzip allows preflight-free uploads and leaving-page beacons (docs/session-replay.md).
 * Validate rates, key, Origin, project settings, filters, and byte budgets before storage. Return
 * 202 after PostgreSQL stores the chunk; replays.ts joins it.
 */
export const replayCollectionRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  projects: ProjectKeyCache;
  /** Activity tab counts (activity/activity.ts). */
  activity: IngestActivity;
  /** Compressed instance quota (Config.replayStorageBytes). */
  limitBytes: number;
  /** Replays are disabled without an object store. */
  storeConfigured: boolean;
  ipLimit?: RateLimit;
  projectLimit?: RateLimit;
  instanceLimit?: RateLimit;
  maxInFlight?: number;
  maxInFlightPerProject?: number;
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
    activity,
  } = options;
  const ipLimiter = new TokenBucketLimiter(options.ipLimit ?? DEFAULT_REPLAY_IP_LIMIT, { now });
  // Charge compressed KiB.
  const budget = new EventBudget(
    new TokenBucketLimiter(options.projectLimit ?? DEFAULT_REPLAY_PROJECT_LIMIT, { now }),
    new TokenBucketLimiter(options.instanceLimit ?? DEFAULT_REPLAY_INSTANCE_LIMIT, { now }),
  );
  const inFlight = new InFlight(
    options.maxInFlight ?? DEFAULT_REPLAY_MAX_IN_FLIGHT,
    options.maxInFlightPerProject ?? DEFAULT_REPLAY_MAX_IN_FLIGHT_PER_PROJECT,
  );
  /** Resolve before reading the body. */
  const projectOf = new WeakMap<FastifyRequest, CollectingProject>();

  // Keep gzip bytes as sent.
  app.addContentTypeParser(
    ["text/plain", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: MAX_CHUNK_BYTES },
    (_request, body, parsed) => {
      parsed(null, body);
    },
  );

  // Expose all answers so the recorder can decide whether to retry (collection/routes.ts).
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
      // Do not expose validator details to unauthenticated callers.
      return reply
        .code(400)
        .send(
          problem(
            "invalid_request",
            "The request is not a replay chunk: check its query (key, replay, seq, last, cut).",
          ),
        );
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
      // Reject rate and key failures before reading bodies.
      onRequest: async (request, reply) => {
        const result = ipLimiter.take(clientKey(request.ip));
        if (!result.allowed) return tooManyRequests(reply, result.retryAfterSeconds);
        const query: unknown = request.query;
        const key = typeof query === "object" && query !== null ? Reflect.get(query, "key") : "";
        // Repeated key parameters produce an array; require one key.
        if (typeof key !== "string" || !KEY.test(key)) {
          return reply
            .code(400)
            .send(problem("invalid_request", "Send the project's public key once, as key=pk_…."));
        }
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
        projectOf.set(request, project);
        return undefined;
      },
      // Acquire slots after body arrival so slow uploads hold none.
      preHandler: async (request, reply) => {
        const project = projectOf.get(request);
        if (project === undefined) return undefined;
        if (!inFlight.take(request, reply)) {
          return reply
            .code(503)
            .header("retry-after", "1")
            .send(problem("busy", "Too many replay chunks are in progress. Try again shortly."));
        }
        if (!inFlight.takeForProject(request, project.id)) {
          activity.add(project.id, "replays", "refused_rate_limited", 0);
          return tooManyRequests(reply, 1);
        }
        return undefined;
      },
      onResponse: inFlight.finished,
      onRequestAbort: inFlight.finished,
    },
    // Hold the slot through storage.
    async (request, reply) =>
      inFlight.run(request, async () => {
        const { replay, seq, last, cut } = request.query;
        const project = projectOf.get(request);
        if (project === undefined) {
          throw new Error("the replay onRequest hook must find its project first");
        }
        const projectId = project.id;
        const count = (outcome: IngestOutcome, items = 0) => {
          activity.add(projectId, "replays", outcome, items);
        };
        const origin = request.headers.origin;
        if (origin !== undefined) {
          const hostname = originHostname(origin);
          if (hostname === null || !isAllowedHostname(hostname, project.allowedHostnames)) {
            count("refused_origin");
            return reply
              .code(403)
              .send(problem("origin_not_allowed", "This site may not send to this project."));
          }
        }
        // replay_off stops recording for this page load.
        if (project.replayMode !== "errors") {
          count("refused_disabled");
          return reply
            .code(403)
            .send(problem("replay_off", "The project does not take session replays."));
        }
        if (!storeConfigured) {
          count("refused_disabled");
          return reply
            .code(403)
            .send(
              problem(
                "replay_off",
                "This instance has no object store. Session replays are disabled.",
              ),
            );
        }
        if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
          count("refused_invalid");
          return reply.code(400).send(problem("invalid_request", "Send the chunk as the body."));
        }
        let unpackedBytes;
        try {
          unpackedBytes = gunzipSync(request.body, {
            maxOutputLength: MAX_CHUNK_UNPACKED_BYTES,
          }).byteLength;
        } catch (error) {
          count("refused_invalid");
          return error instanceof RangeError
            ? reply
                .code(413)
                .send(problem("payload_too_large", "A chunk unpacks to at most 1 MiB."))
            : reply.code(400).send(problem("invalid_request", "The chunk is not gzip."));
        }
        // Filter before spending budgets, matching collection/routes.ts.
        if (isBlockedAddress(project.blocked, request.ip)) {
          count("filtered_spam", 1);
          return reply.code(202).send(RECEIVED);
        }
        if (
          isBot(request.headers["user-agent"]) ||
          (project.ignoreDataCenters && isDataCenter(request.ip))
        ) {
          count("filtered_bot", 1);
          return reply.code(202).send(RECEIVED);
        }
        const spent = budget.take(project.id, Math.ceil(request.body.byteLength / 1024));
        if (!spent.allowed) {
          count(spent.limit === "instance" ? "refused_volume" : "refused_rate_limited");
          return tooManyRequests(reply, spent.retryAfterSeconds);
        }

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
              unpackedBytes,
            },
            limitBytes,
          );
        } catch (error) {
          request.log.error({ err: error }, "could not store a replay chunk");
          count("refused_unavailable");
          return storageUnavailable(reply);
        }
        switch (result) {
          case "storage_full":
            count("refused_volume");
            return reply
              .code(403)
              .send(
                problem(
                  "replay_storage_full",
                  "The instance's replays have reached their storage limit.",
                ),
              );
          case "too_large":
            // The storage-limit UI also explains individual replay limits.
            count("refused_volume");
            return reply
              .code(413)
              .send(problem("replay_too_large", "A replay is at most 2 MB, compressed."));
          case "unpacked_too_large":
            count("refused_volume");
            return reply
              .code(413)
              .send(
                problem(
                  "replay_too_large",
                  `A replay unpacks to at most ${MAX_REPLAY_UNPACKED_BYTES / 1024 ** 2} MiB. Its chunks so far are kept; later ones are not.`,
                ),
              );
          default:
            // Duplicates are accepted without counting a new chunk.
            count("accepted", result === "stored" ? 1 : 0);
            return reply.code(202).send(RECEIVED);
        }
      }),
  );

  done();
};
