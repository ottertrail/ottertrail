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

/** Chunks per client address: one replay is a few dozen at most. */
export const DEFAULT_REPLAY_IP_LIMIT: RateLimit = { capacity: 100, refillPerSecond: 2 };
/**
 * Replay bytes, in KiB, per project and per instance, apart from events'
 * budgets, so recordings never crowd events out: bursts of a few replays,
 * and a steady flow of about one 2 MB replay every 8 seconds for a project
 * and 3 for the instance. Provisional, until measured on real
 * sites (docs/session-replay.md, "Decisions still open").
 */
export const DEFAULT_REPLAY_PROJECT_LIMIT: RateLimit = { capacity: 8192, refillPerSecond: 256 };
export const DEFAULT_REPLAY_INSTANCE_LIMIT: RateLimit = {
  capacity: 24_576,
  refillPerSecond: 768,
};
/**
 * Chunks this process works on at once, and one project's of them, each
 * counted from when its body has arrived (at most 64 KB) until it is
 * stored: it holds that body and, while checked, up to 1 MiB unpacked. A
 * page leaving sends all its pieces at once, by beacon, which never
 * retries, so one project's cap is well above a replay's 100 pieces.
 */
export const DEFAULT_REPLAY_MAX_IN_FLIGHT = 256;
export const DEFAULT_REPLAY_MAX_IN_FLIGHT_PER_PROJECT = 128;
const KEY = new RegExp(PUBLIC_KEY_PATTERN);

const problem = (error: string, message: string) => ({ error, message });
/**
 * The answer to every chunk accepted: stored, a retry of one stored, or
 * filtered (blocked address, bot, data center), so a sender never learns
 * which.
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
 * POST /api/replays?key=pk_…&replay=<uuid>&seq=<n>&last=0|1&cut=0|1
 *
 * A chunk of a session replay (docs/session-replay.md), as the tracker's
 * recorder sends it: one gzip member of a piece of the recording's JSON,
 * as text/plain, so a page sends it without a preflight, and with a beacon
 * when it is closing. Checked as events are, cheapest first: the address's
 * rate, the body's size, the public key, the page's origin against the
 * project's allowed hostnames, the project's replay setting, its blocked
 * addresses, bots, and its
 * own budgets in bytes. 202 once PostgreSQL has it; the worker joins a
 * replay's chunks (replays.ts).
 */
export const replayCollectionRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  projects: ProjectKeyCache;
  /** Counts for the Activity tab (activity/activity.ts). */
  activity: IngestActivity;
  /** Compressed replay bytes the instance may keep (Config.replayStorageBytes). */
  limitBytes: number;
  /** Whether the install has an object store to keep replays in: without one, they are off. */
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
  // In KiB: a chunk costs its size.
  const budget = new EventBudget(
    new TokenBucketLimiter(options.projectLimit ?? DEFAULT_REPLAY_PROJECT_LIMIT, { now }),
    new TokenBucketLimiter(options.instanceLimit ?? DEFAULT_REPLAY_INSTANCE_LIMIT, { now }),
  );
  const inFlight = new InFlight(
    options.maxInFlight ?? DEFAULT_REPLAY_MAX_IN_FLIGHT,
    options.maxInFlightPerProject ?? DEFAULT_REPLAY_MAX_IN_FLIGHT_PER_PROJECT,
  );
  /** The project each chunk's key names, found before its body is read. */
  const projectOf = new WeakMap<FastifyRequest, CollectingProject>();

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
      // Never the validator's own text: the caller is not signed in.
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
      // Before the body is read: the cheapest way to turn a flood away, the
      // key's form, and the key itself.
      onRequest: async (request, reply) => {
        const result = ipLimiter.take(clientKey(request.ip));
        if (!result.allowed) return tooManyRequests(reply, result.retryAfterSeconds);
        const query: unknown = request.query;
        const key = typeof query === "object" && query !== null ? Reflect.get(query, "key") : "";
        // One key of the public key's form: `?key=a&key=b` is an array.
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
      // Once the body has arrived: a slot of this process's and of the
      // project's, so slow bodies hold none.
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
    // The slot is held until the chunk is stored.
    async (request, reply) =>
      inFlight.run(request, async () => {
        const { replay, seq, last, cut } = request.query;
        const project = projectOf.get(request);
        if (project === undefined) {
          throw new Error("the replay onRequest hook must find its project first");
        }
        // Known from here: what becomes of the chunk is counted, one item a chunk.
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
        // "replay_off" stops the page's recorder for the rest of its load.
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
        // Accepted and ignored, as their events are (collection/routes.ts):
        // the project's blocked addresses, bots, and data centers. Before the
        // budget, so they cannot use it up.
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
            // One replay's own limit: also a storage limit, which the sheet explains.
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
            // A duplicate is a retry of a chunk already stored: accepted, no new item.
            count("accepted", result === "stored" ? 1 : 0);
            return reply.code(202).send(RECEIVED);
        }
      }),
  );

  done();
};
