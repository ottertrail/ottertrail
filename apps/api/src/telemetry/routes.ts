import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

import type { IngestActivity, IngestOutcome, IngestSource } from "../activity/activity.ts";
import { aiCallsOf } from "../ai/calls.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { type NewEvent, storeEvents } from "../collection/event-store.ts";
import { InFlight } from "../collection/in-flight.ts";
import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";
import {
  EventBudget,
  type RateLimit,
  TELEMETRY_INSTANCE_LIMIT,
  TELEMETRY_PROJECT_LIMIT,
  clientKey,
  TokenBucketLimiter,
} from "../collection/rate-limiter.ts";
import { DEFAULT_SERVER_IP_LIMIT } from "../collection/server-events.ts";
import { BUSY, SecretKeyLookups } from "./key-lookups.ts";
import {
  type NormalizeContext,
  normalizeLogs,
  normalizeMetrics,
  normalizeTraces,
  type Outcome,
} from "./normalize.ts";
import {
  LOGS_MESSAGES,
  METRICS_MESSAGES,
  type SignalMessages,
  TRACE_MESSAGES,
} from "./proto/definitions.ts";
import { MalformedError } from "./read.ts";
import { insertTelemetry, type TelemetryRows } from "./store.ts";
import {
  CONTENT_TYPES,
  countMessages,
  decodeRequest,
  type Encoding,
  encodeMessage,
  encodingOf,
  MAX_MESSAGES,
  statusBody,
  TooManyMessagesError,
} from "./wire.ts";

const gunzipAsync = promisify(gunzip);

/** Uncompressed body limit (docs/telemetry.md, "Limits"). */
export const MAX_TELEMETRY_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Budgets charge per record, MESSAGES_PER_UNIT decoded messages, or BYTES_PER_UNIT row bytes,
 * including repeated resources. This bounds work from large attributes and resources.
 */
export const MESSAGES_PER_UNIT = 64;
export const BYTES_PER_UNIT = 2048;

/** Bounds memory held by decoded requests per process. */
export const DEFAULT_MAX_IN_FLIGHT = 8;
/** Prevents one project from occupying every request slot. */
export const DEFAULT_MAX_IN_FLIGHT_PER_PROJECT = 4;

function costBeforeDecoding(messages: number, bodyBytes: number): number {
  return Math.max(
    1,
    Math.ceil(messages / MESSAGES_PER_UNIT),
    Math.ceil(bodyBytes / BYTES_PER_UNIT),
  );
}

const BEARER = /^Bearer (sk_[0-9a-f]{32})$/;

interface Signal {
  path: string;
  source: IngestSource;
  stored: (rows: TelemetryRows) => number;
  messages: SignalMessages;
  /** OTLP partial_success field for refused records. */
  rejectedField: string;
  normalize: (
    request: object,
    context: NormalizeContext,
  ) => Outcome & { rows: TelemetryRows; errors: NewEvent[] };
}

const SIGNALS: Signal[] = [
  {
    path: "/v1/traces",
    source: "traces",
    stored: (rows) => rows.spans?.length ?? 0,
    messages: TRACE_MESSAGES,
    rejectedField: "rejectedSpans",
    normalize: (request, context) => {
      const { rows, ...outcome } = normalizeTraces(request, context);
      return { ...outcome, rows: { spans: rows, ai_calls: aiCallsOf(rows) } };
    },
  },
  {
    path: "/v1/logs",
    source: "logs",
    stored: (rows) => rows.logs?.length ?? 0,
    messages: LOGS_MESSAGES,
    rejectedField: "rejectedLogRecords",
    normalize: (request, context) => {
      const { rows, ...outcome } = normalizeLogs(request, context);
      return { ...outcome, rows: { logs: rows } };
    },
  },
  {
    path: "/v1/metrics",
    source: "metrics",
    stored: (rows) => (rows.metric_points?.length ?? 0) + (rows.metric_histograms?.length ?? 0),
    messages: METRICS_MESSAGES,
    rejectedField: "rejectedDataPoints",
    normalize: (request, context) => {
      const { points, histograms, ...outcome } = normalizeMetrics(request, context);
      return {
        ...outcome,
        rows: { metric_points: points, metric_histograms: histograms },
        errors: [],
      };
    },
  },
];

export interface TelemetryOptions {
  clickhouse: ClickHouseClient;
  projects: ProjectKeyCache;
  /** Activity tab counts (activity/activity.ts). */
  activity: IngestActivity;
  /** Rejects older records (Config.telemetryRetentionDays). */
  retentionDays: number;
  ipLimit?: RateLimit;
  /** Project and instance record budgets, also charged by bytes (BYTES_PER_UNIT). */
  projectLimit?: RateLimit;
  instanceLimit?: RateLimit;
  /**
   * Shared with POST /api/ai-calls (ai/ingest-routes.ts). Defaults to a budget built from the
   * limits.
   */
  budget?: EventBudget;
  maxInFlight?: number;
  maxInFlightPerProject?: number;
  /** Defaults to this route's own lookup limiter (key-lookups.ts). */
  keyLookups?: SecretKeyLookups;
  /** Milliseconds since 1970; injectable for tests. */
  now?: () => number;
}

export function telemetryBudget(
  limits: Pick<TelemetryOptions, "projectLimit" | "instanceLimit">,
): EventBudget {
  return new EventBudget(
    new TokenBucketLimiter(limits.projectLimit ?? TELEMETRY_PROJECT_LIMIT),
    new TokenBucketLimiter(limits.instanceLimit ?? TELEMETRY_INSTANCE_LIMIT),
  );
}

/** Falls back to JSON when the request encoding is unsupported. */
function answerEncoding(request: FastifyRequest): Encoding {
  return encodingOf(request.headers["content-type"]) ?? "json";
}

function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  httpStatus: number,
  text: string,
  retryAfterSeconds?: number,
) {
  const encoding = answerEncoding(request);
  if (retryAfterSeconds !== undefined) reply.header("retry-after", String(retryAfterSeconds));
  return reply
    .code(httpStatus)
    .type(CONTENT_TYPES[encoding])
    .send(statusBody(httpStatus, text, encoding));
}

/**
 * OTLP/HTTP requires project secret keys because these endpoints collect server telemetry
 * (docs/telemetry.md).
 *
 * Validate authentication, rate, encoding, and concurrency before reading the body. Cap unpacked
 * bodies at 16 MiB and count MAX_MESSAGES before decoding to bound allocations. Charge decoding
 * first, then stored rows, exception events (exceptions.ts), and AI calls (ai/calls.ts); AI
 * charges cannot exceed the whole budget. Event budgets are separate.
 *
 * Acknowledge only after ClickHouse writes all rows. Write failures return 503 for exporters to
 * retry; ClickHouse deduplicates stable row identities.
 */
export const telemetryRoutes: FastifyPluginCallback<TelemetryOptions> = (app, options, done) => {
  const {
    clickhouse,
    projects,
    activity,
    retentionDays,
    now = Date.now,
    keyLookups = new SecretKeyLookups(),
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
    maxInFlightPerProject = DEFAULT_MAX_IN_FLIGHT_PER_PROJECT,
  } = options;
  const ipLimiter = new TokenBucketLimiter(options.ipLimit ?? DEFAULT_SERVER_IP_LIMIT);
  const budget = options.budget ?? telemetryBudget(options);
  /** Resolved before reading the body. */
  const projectOf = new WeakMap<FastifyRequest, CollectingProject>();
  const inFlight = new InFlight(maxInFlight, maxInFlightPerProject);
  const sourceOf = new Map(SIGNALS.map((signal) => [signal.path, signal.source]));
  /** Counts only requests whose project is known (activity/activity.ts). */
  const count = (
    request: FastifyRequest,
    outcome: IngestOutcome,
    items = 0,
    project = projectOf.get(request),
  ) => {
    const source = sourceOf.get(request.routeOptions.url ?? "");
    if (project !== undefined && source !== undefined) {
      activity.add(project.id, source, outcome, items);
    }
  };

  // Keep bytes until decompression, then parse JSON. Limit both compressed and unpacked sizes.
  app.addContentTypeParser(
    [CONTENT_TYPES.protobuf, CONTENT_TYPES.json],
    { parseAs: "buffer", bodyLimit: MAX_TELEMETRY_BODY_BYTES },
    (_request, body, parsed) => {
      parsed(null, body);
    },
  );

  // Return OTLP errors for Fastify body-read failures too.
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    // The key was resolved before body parsing, so refusals still count against the project.
    if (statusCode >= 400 && statusCode < 500) count(request, "refused_invalid");
    if (statusCode === 413) {
      return fail(request, reply, 413, "The body is larger than 16 MiB.");
    }
    if (statusCode === 415) {
      return fail(request, reply, 415, "Send application/x-protobuf or application/json.");
    }
    if (statusCode >= 400 && statusCode < 500) {
      return fail(request, reply, 400, "The request could not be read.");
    }
    request.log.error({ err: error }, "could not take telemetry");
    return fail(request, reply, 500, "The request failed.");
  });

  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const secretKey = BEARER.exec(request.headers.authorization ?? "")?.[1];
    if (secretKey === undefined) {
      return fail(request, reply, 401, "Send the project's secret key: Authorization: Bearer sk_…");
    }
    const allowed = ipLimiter.take(clientKey(request.ip));
    if (!allowed.allowed) {
      return fail(
        request,
        reply,
        429,
        "Too many requests from this address.",
        allowed.retryAfterSeconds,
      );
    }
    if (encodingOf(request.headers["content-type"]) === null) {
      return fail(
        request,
        reply,
        415,
        "Send application/x-protobuf or application/json, as OTLP/HTTP does.",
      );
    }
    const contentEncoding = (request.headers["content-encoding"] ?? "identity").toLowerCase();
    if (contentEncoding !== "gzip" && contentEncoding !== "identity") {
      return fail(request, reply, 415, "Send the body as it is, or with Content-Encoding: gzip.");
    }
    // Resolve keys before taking slots so made-up keys cannot occupy ingestion capacity.
    let project;
    try {
      project = await keyLookups.findFor(projects, secretKey, request, reply);
    } catch (error) {
      request.log.error({ err: error }, "could not look up the secret key");
      return fail(request, reply, 503, "Telemetry was not stored. Retry later.", 5);
    }
    if (project === BUSY) {
      return fail(request, reply, 503, "Too many keys are being looked up. Try again shortly.", 1);
    }
    if (project === null) {
      return fail(request, reply, 401, "No project has this secret key.");
    }
    if (!inFlight.take(request, reply)) {
      return fail(request, reply, 503, "Too many requests are in progress. Try again shortly.", 1);
    }
    if (!inFlight.takeForProject(request, project.id)) {
      // Disconnected requests take no slot and do not count as refusals.
      if (!reply.raw.destroyed) count(request, "refused_rate_limited", 0, project);
      return fail(
        request,
        reply,
        429,
        "Too many requests from this project are in progress. Try again shortly.",
        1,
      );
    }
    projectOf.set(request, project);
    return undefined;
  };

  for (const signal of SIGNALS) {
    app.post<{ Body: Buffer | undefined }>(
      signal.path,
      {
        bodyLimit: MAX_TELEMETRY_BODY_BYTES,
        onRequest,
        onResponse: inFlight.finished,
        onRequestAbort: inFlight.finished,
      },
      // Hold the slot through insertion.
      async (request, reply) =>
        inFlight.run(request, async () => {
          const project = projectOf.get(request);
          if (project === undefined) {
            throw new Error("the telemetry onRequest hook must find its project first");
          }
          const encoding = answerEncoding(request);
          const sent = request.body ?? Buffer.alloc(0);
          const invalid = (httpStatus: 400 | 413, text: string) => {
            count(request, "refused_invalid");
            return fail(request, reply, httpStatus, text);
          };

          let body: Buffer;
          if ((request.headers["content-encoding"] ?? "").toLowerCase() === "gzip") {
            try {
              body = await gunzipAsync(sent, { maxOutputLength: MAX_TELEMETRY_BODY_BYTES });
            } catch (error) {
              return error instanceof RangeError
                ? invalid(413, "The body is larger than 16 MiB once unpacked.")
                : invalid(400, "The body is not valid gzip.");
            }
          } else {
            body = sent;
          }

          // Charge before decoding: every message allocates, even if it produces no records.
          let messageCount: number;
          try {
            messageCount = countMessages(signal.messages, body, encoding);
          } catch (error) {
            if (error instanceof TooManyMessagesError) {
              return invalid(
                413,
                `A request decodes into at most ${MAX_MESSAGES} messages (records, attributes, values). Send smaller batches.`,
              );
            }
            if (error instanceof MalformedError) return invalid(400, error.message);
            throw error;
          }
          const tooLarge = (cost: number) =>
            invalid(
              413,
              `A request may cost at most ${budget.capacity} (one per record, or more for numerous or large attributes). This request costs ${cost}. Send smaller batches.`,
            );
          const tooMuch = (limit: "project" | "instance", retryAfterSeconds: number) => {
            count(request, limit === "instance" ? "refused_volume" : "refused_rate_limited");
            return fail(
              request,
              reply,
              429,
              `Too many records for this project. Retry after ${retryAfterSeconds} seconds.`,
              retryAfterSeconds,
            );
          };
          const prepaid = costBeforeDecoding(messageCount, body.length);
          if (prepaid > budget.capacity) return tooLarge(prepaid);
          const paid = budget.take(project.id, prepaid);
          if (!paid.allowed) return tooMuch(paid.limit, paid.retryAfterSeconds);

          // Malformed and refused requests still pay for decoding already done.
          let outcome: Outcome & { rows: TelemetryRows; errors: NewEvent[] };
          const receivedAt = now();
          try {
            outcome = signal.normalize(decodeRequest(signal.messages, body, encoding), {
              projectId: project.id,
              receivedAtNs: BigInt(receivedAt) * 1_000_000n,
              retentionDays,
            });
          } catch (error) {
            if (error instanceof MalformedError) return invalid(400, error.message);
            // Log runtime error details without exposing them to senders.
            if (error instanceof RangeError) {
              request.log.warn({ err: error }, "telemetry request held a value out of range");
              return invalid(
                400,
                "The request holds a value out of range. Check the times and numbers the exporter sends.",
              );
            }
            throw error;
          }

          if (outcome.records > budget.capacity) {
            return invalid(
              413,
              `A request holds at most ${budget.capacity} records. This request contains ${outcome.records}. Send smaller batches.`,
            );
          }
          // Charge each exception row so spans cannot multiply writes for free. Refused records
          // pay only for decoding.
          const base =
            Math.max(
              prepaid,
              signal.stored(outcome.rows),
              Math.ceil((body.length + outcome.sharedBytes) / BYTES_PER_UNIT),
            ) + outcome.errors.length;
          if (base > budget.capacity) return tooLarge(base);
          // Cap AI charges at the budget so an otherwise valid batch gets retryable 429 instead of
          // permanent 413.
          const cost = Math.min(budget.capacity, base + (outcome.rows.ai_calls?.length ?? 0));
          if (cost > prepaid) {
            const rest = budget.take(project.id, cost - prepaid);
            if (!rest.allowed) return tooMuch(rest.limit, rest.retryAfterSeconds);
          }
          try {
            await Promise.all([
              insertTelemetry(clickhouse, outcome.rows, { receivedAt: new Date(receivedAt) }),
              storeEvents(clickhouse, project.id, outcome.errors, {
                receivedAt: new Date(receivedAt),
              }),
            ]);
          } catch (error) {
            // Refund server-side failures.
            budget.refund(project.id, cost);
            request.log.error({ err: error }, "could not store telemetry");
            count(request, "refused_unavailable");
            return fail(request, reply, 503, "Telemetry was not stored. Retry later.", 5);
          }
          // Also count derived error events and AI calls in their sources.
          const stored = signal.stored(outcome.rows);
          if (stored > 0) count(request, "accepted", stored);
          if (outcome.refused > 0) count(request, "refused_invalid", outcome.refused);
          if (outcome.errors.length > 0) {
            activity.add(project.id, "errors", "accepted", outcome.errors.length);
          }
          const aiCalls = outcome.rows.ai_calls?.length ?? 0;
          if (aiCalls > 0) activity.add(project.id, "ai_calls", "accepted", aiCalls);

          const response =
            outcome.refused === 0
              ? {}
              : {
                  partialSuccess: {
                    [signal.rejectedField]: outcome.refused,
                    errorMessage: outcome.message,
                  },
                };
          return reply
            .code(200)
            .type(CONTENT_TYPES[encoding])
            .send(encodeMessage(signal.messages.response, response, encoding));
        }),
    );
  }
  done();
};
