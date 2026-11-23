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

/** A request's body, unpacked, at most this many bytes (docs/telemetry.md, "Limits"). */
export const MAX_TELEMETRY_BODY_BYTES = 16 * 1024 * 1024;

/**
 * What a request spends of its project's and the instance's budgets: one
 * per record, or, when it holds more than records usually do, one per
 * MESSAGES_PER_UNIT messages it decodes into, or per BYTES_PER_UNIT bytes
 * its rows hold (its body, and the resource attributes each row repeats).
 * So a request's cost follows the work it makes: a few records with many
 * attributes, or with a large resource each copies, cost as much as the
 * records that would be as much work.
 */
export const MESSAGES_PER_UNIT = 64;
export const BYTES_PER_UNIT = 2048;

/**
 * Days (UTC) one request's records may fall on: each day is a partition
 * of every table it writes to, so a request spread over many days would
 * make that many parts at once.
 */
export const MAX_DAYS_PER_REQUEST = 8;

/** The days the rows of the day-partitioned tables fall on. */
function daysOf(rows: TelemetryRows): number {
  const days = new Set<string>();
  for (const table of [rows.spans, rows.logs, rows.metric_points, rows.metric_histograms]) {
    for (const row of table ?? []) days.add(row.timestamp.slice(0, 10));
  }
  return days.size;
}

/** Requests one process works on at once, by default: each holds its body, decoded, in memory. */
export const DEFAULT_MAX_IN_FLIGHT = 8;
/** Of those, one project's at most, by default, so one project's exporters cannot take them all. */
export const DEFAULT_MAX_IN_FLIGHT_PER_PROJECT = 4;

/** What a request costs before it is decoded: what its size and messages alone make. */
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
  /** Where its requests count on the Activity tab. */
  source: IngestSource;
  /** The records a request stored: spans, log records, or data points. */
  stored: (rows: TelemetryRows) => number;
  messages: SignalMessages;
  /** The response's partial_success field counting refused records. */
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
  /** Counts for the Activity tab (activity/activity.ts). */
  activity: IngestActivity;
  /** Days telemetry is kept (Config.telemetryRetentionDays): older records are refused. */
  retentionDays: number;
  /** Requests per client address. */
  ipLimit?: RateLimit;
  /** Spans, log records, and data points per project, and per instance (see BYTES_PER_UNIT). */
  projectLimit?: RateLimit;
  instanceLimit?: RateLimit;
  /**
   * The budget those limits make, when it is shared with POST
   * /api/ai-calls (ai/ingest-routes.ts); made here from them when omitted.
   */
  budget?: EventBudget;
  /** Requests this process works on at once (DEFAULT_MAX_IN_FLIGHT). */
  maxInFlight?: number;
  /** Of those, one project's (DEFAULT_MAX_IN_FLIGHT_PER_PROJECT). */
  maxInFlightPerProject?: number;
  /** The clock, in milliseconds since 1970; tests fix it. */
  now?: () => number;
}

/** The telemetry budget: per project, inside the instance's. */
export function telemetryBudget(
  limits: Pick<TelemetryOptions, "projectLimit" | "instanceLimit">,
): EventBudget {
  return new EventBudget(
    new TokenBucketLimiter(limits.projectLimit ?? TELEMETRY_PROJECT_LIMIT),
    new TokenBucketLimiter(limits.instanceLimit ?? TELEMETRY_INSTANCE_LIMIT),
  );
}

/** The encoding to answer in: the request's, or JSON when it named none OTLP uses. */
function answerEncoding(request: FastifyRequest): Encoding {
  return encodingOf(request.headers["content-type"]) ?? "json";
}

/** An error answer, as OTLP has them: a Status in the request's encoding. */
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
 * OTLP/HTTP (docs/telemetry.md): POST /v1/traces, /v1/logs, and
 * /v1/metrics, at the instance's root, where an exporter pointed at it
 * sends them. Authenticated by the project's secret key, never a public
 * one: these come from servers.
 *
 * Before the body is read: the key's form, the address's rate, the
 * encoding, the key itself, and how many requests this process and the
 * key's project have in progress. Then the body is unpacked (at most
 * 16 MiB), and its messages counted without decoding (at most
 * MAX_MESSAGES), which pays the budgets for decoding it. Then it is decoded
 * and turned into rows; records the tables cannot take are refused and
 * counted in partial_success; the rest of its cost is paid, with a unit
 * more for each exception that becomes an error event (exceptions.ts) and
 * each span that is an AI call (ai/calls.ts), the AI calls' units up to
 * the whole budget. The budgets are apart from events'. The answer is sent once ClickHouse has written the rows, the
 * error events, and the AI calls (asynchronous inserts, waiting for
 * them), and is 503 while it cannot, which exporters retry: a retry writes
 * the same rows and events again, which ClickHouse keeps once.
 */
export const telemetryRoutes: FastifyPluginCallback<TelemetryOptions> = (app, options, done) => {
  const {
    clickhouse,
    projects,
    activity,
    retentionDays,
    now = Date.now,
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
    maxInFlightPerProject = DEFAULT_MAX_IN_FLIGHT_PER_PROJECT,
  } = options;
  const ipLimiter = new TokenBucketLimiter(options.ipLimit ?? DEFAULT_SERVER_IP_LIMIT);
  const budget = options.budget ?? telemetryBudget(options);
  /** The project each request's key names, found before its body is read. */
  const projectOf = new WeakMap<FastifyRequest, CollectingProject>();
  /** Requests in progress (in-flight.ts). */
  const inFlight = new InFlight(maxInFlight, maxInFlightPerProject);
  /** Each signal's source, by its path. */
  const sourceOf = new Map(SIGNALS.map((signal) => [signal.path, signal.source]));
  /** Counts a request whose project is known (activity/activity.ts); others are not. */
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

  // Both encodings as bytes: protobuf needs them, and JSON is parsed only
  // once unpacked. The limit applies to the body as sent; a gzip body is
  // limited again once unpacked.
  app.addContentTypeParser(
    [CONTENT_TYPES.protobuf, CONTENT_TYPES.json],
    { parseAs: "buffer", bodyLimit: MAX_TELEMETRY_BODY_BYTES },
    (_request, body, parsed) => {
      parsed(null, body);
    },
  );

  // Fastify's own refusals (a body too large, one it cannot read) as OTLP's.
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    // The key was read before the body: a body refused here is the project's.
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
    // The key is looked up before a slot is taken, so lookups of made-up
    // keys cannot hold the slots real requests need.
    let project;
    try {
      project = await projects.findBySecret(secretKey);
    } catch (error) {
      request.log.error({ err: error }, "could not look up the secret key");
      return fail(request, reply, 503, "Telemetry was not stored. Retry later.", 5);
    }
    if (project === null) {
      return fail(request, reply, 401, "No project has this secret key.");
    }
    if (!inFlight.take(request, reply)) {
      return fail(request, reply, 503, "Too many requests are in progress. Try again shortly.", 1);
    }
    if (!inFlight.takeForProject(request, project.id)) {
      count(request, "refused_rate_limited", 0, project);
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
      // The slot is held until the work settles, the insert included.
      async (request, reply) =>
        inFlight.run(request, async () => {
          const project = projectOf.get(request);
          if (project === undefined) {
            throw new Error("the telemetry onRequest hook must find its project first");
          }
          const encoding = answerEncoding(request);
          const sent = request.body ?? Buffer.alloc(0);
          // What becomes of the request is counted from here (activity/activity.ts).
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

          // Counted, and paid for, before decoding: decoding allocates for
          // every message, and costs the same whether records come of it or not.
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

          // Neither a malformed request nor one refused below gets its
          // decoding back: it was done.
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
            // Its text is the runtime's, not written for senders: logged, not sent.
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
          const days = daysOf(outcome.rows);
          if (days > MAX_DAYS_PER_REQUEST) {
            return invalid(
              413,
              `A request may hold records of at most ${MAX_DAYS_PER_REQUEST} days (UTC). This request holds ${days}. Send fewer days at a time.`,
            );
          }
          // Each error event is one more row, in the events table: so a
          // span's exceptions cannot multiply rows for free.
          const base =
            Math.max(
              prepaid,
              outcome.records,
              Math.ceil((body.length + outcome.sharedBytes) / BYTES_PER_UNIT),
            ) + outcome.errors.length;
          if (base > budget.capacity) return tooLarge(base);
          // Each AI call is one more too, in ai_calls, but never makes a
          // request too large: a batch the budget could take without them is
          // charged at most the whole budget, and waits for it (429, which
          // exporters retry), rather than being refused for good (413).
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
            // Not the sender's doing: all of it back.
            budget.refund(project.id, cost);
            request.log.error({ err: error }, "could not store telemetry");
            count(request, "refused_unavailable");
            return fail(request, reply, 503, "Telemetry was not stored. Retry later.", 5);
          }
          // The records stored, and those refused in partial_success, per
          // item; the error events and AI calls the spans and logs held
          // count in those sources too.
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
