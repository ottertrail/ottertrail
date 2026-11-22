import type { FastifyError, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { insertRows } from "../clickhouse/insert.ts";
import { AI_CALLS_TABLE } from "../clickhouse/migrations.ts";
import { ENVIRONMENT_PATTERN, environmentOf, RELEASE_PATTERN } from "../collection/environment.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import { isStorableText, MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";
import {
  clientKey,
  type EventBudget,
  type RateLimit,
  TokenBucketLimiter,
} from "../collection/rate-limiter.ts";
import { DEFAULT_SERVER_IP_LIMIT, MAX_FUTURE_MS } from "../collection/server-events.ts";
import { nanosText } from "../telemetry/normalize.ts";
import { DEFAULT_MAX_IN_FLIGHT, DEFAULT_MAX_IN_FLIGHT_PER_PROJECT } from "../telemetry/routes.ts";
import {
  type AiCallRow,
  cleanLabel,
  MAX_AI_ERROR_TYPE_CHARS,
  MAX_AI_LABEL_CHARS,
  MAX_FINISH_REASON_CHARS,
  MAX_FINISH_REASONS,
  MAX_TOKENS,
} from "./calls.ts";

/** Calls in one request (docs/ai-usage.md, "Sending calls over HTTP"). */
export const MAX_AI_CALLS_PER_BATCH = 1000;
/** A request's body: 1,000 calls of usual size fit with room to spare. */
export const MAX_AI_CALLS_BODY_BYTES = 1024 * 1024;
/** A call's duration, and its time to the first chunk, at most a day. */
const MAX_CALL_MS = 86_400_000;

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const BEARER = /^Bearer (sk_[0-9a-f]{32})$/;
/**
 * No control characters (C0, DEL, and C1), as user IDs. A required name
 * has at least one; an optional one may be "", which is as left out.
 */
const textOf = (max: number, min = 1) => ({
  type: "string",
  pattern: `^[^\\u0000-\\u001F\\u007F-\\u009F]{${min},${max}}$`,
});
const optionalTextOf = (max: number) => textOf(max, 0);
const TOKENS = { type: "integer", minimum: 0, maximum: MAX_TOKENS };
const MILLISECONDS = { type: "number", minimum: 0, maximum: MAX_CALL_MS };

interface HttpAiCall {
  id: string;
  /** When the call started, in milliseconds since 1970: the server's clock is trusted. */
  occurredAt: number;
  provider: string;
  model: string;
  operation?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  durationMs: number;
  firstChunkMs?: number;
  ok?: boolean;
  errorType?: string;
  finishReasons?: string[];
  userId?: string;
  feature?: string;
  service?: string;
  traceId?: string;
  spanId?: string;
}

interface HttpAiBatch {
  v: 1;
  environment?: string;
  release?: string;
  calls: HttpAiCall[];
}

const batchSchema = {
  type: "object",
  required: ["v", "calls"],
  additionalProperties: false,
  properties: {
    v: { const: 1 },
    environment: { type: "string", pattern: ENVIRONMENT_PATTERN },
    release: { type: "string", maxLength: 200, pattern: RELEASE_PATTERN },
    calls: {
      type: "array",
      minItems: 1,
      maxItems: MAX_AI_CALLS_PER_BATCH,
      items: {
        type: "object",
        required: ["id", "occurredAt", "provider", "model", "durationMs"],
        // Any other field, a prompt or a completion included, is dropped
        // by the schema (Fastify's removeAdditional), as server events'.
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: UUID_PATTERN },
          occurredAt: { type: "integer", minimum: 0, maximum: 8_640_000_000_000_000 },
          provider: textOf(MAX_AI_LABEL_CHARS),
          model: textOf(MAX_AI_LABEL_CHARS),
          operation: optionalTextOf(MAX_AI_LABEL_CHARS),
          inputTokens: TOKENS,
          outputTokens: TOKENS,
          cacheReadTokens: TOKENS,
          cacheWriteTokens: TOKENS,
          reasoningTokens: TOKENS,
          durationMs: MILLISECONDS,
          firstChunkMs: MILLISECONDS,
          ok: { type: "boolean" },
          errorType: optionalTextOf(MAX_AI_ERROR_TYPE_CHARS),
          finishReasons: {
            type: "array",
            maxItems: MAX_FINISH_REASONS,
            items: optionalTextOf(MAX_FINISH_REASON_CHARS),
          },
          userId: { type: "string", maxLength: 200, pattern: USER_ID_PATTERN },
          feature: optionalTextOf(MAX_AI_LABEL_CHARS),
          service: optionalTextOf(MAX_AI_LABEL_CHARS),
          traceId: { type: "string", pattern: "^[0-9a-fA-F]{32}$" },
          spanId: { type: "string", pattern: "^[0-9a-fA-F]{16}$" },
        },
      },
    },
  },
};

function problem(code: string, message: string) {
  return { error: code, message };
}

function storageUnavailable(reply: FastifyReply) {
  return reply
    .code(503)
    .header("retry-after", "5")
    .send(problem("storage_unavailable", "The calls were not stored. Retry later."));
}

/** Milliseconds as nanoseconds, as text: what the table's UInt64 columns take. */
function nanosOf(ms: number): string {
  return BigInt(Math.round(ms * 1e6)).toString();
}

export interface AiCallIngestOptions {
  clickhouse: ClickHouseClient;
  projects: ProjectKeyCache;
  /** The telemetry budget, shared with OTLP (telemetry/routes.ts): each call is a unit. */
  budget: EventBudget;
  /** Requests per client address, an IPv6 address by its /64 (DEFAULT_SERVER_IP_LIMIT). */
  ipLimit?: RateLimit;
  /** Requests this process works on at once, and one project's of them, as OTLP's (telemetry/routes.ts). */
  maxInFlight?: number;
  maxInFlightPerProject?: number;
  now?: () => number;
}

/**
 * POST /api/ai-calls (docs/ai-usage.md, "Sending calls over HTTP"): AI
 * calls an app's server sends itself, for apps without OpenTelemetry,
 * into the same ai_calls table as calls found in spans (calls.ts), so the
 * AI page and the alert rules read them unchanged.
 *
 * As OTLP's (telemetry/routes.ts), before the body is read: the secret
 * key's form, the address's rate, the requests in progress, and the key's
 * project (cached, unknown keys too). Then, as server events
 * (collection/server-events.ts): a schema check, the server's clock trusted (5 minutes
 * ahead at most; over a day old counted, not stored), and 202 only once
 * ClickHouse has written the calls, 503 while it cannot. Each call is a
 * unit of the project's telemetry budget, as a span that is an AI call
 * costs one more. Its row ID is the call's `id`, and its time the one
 * sent, so a retry is the same row, which ReplacingMergeTree keeps once.
 * Token counts only: cost is worked out when calls are read (prices.ts),
 * and the schema has no field for prompts or completions.
 */
export const aiCallIngestRoutes: FastifyPluginCallback<AiCallIngestOptions> = (
  app,
  options,
  done,
) => {
  const {
    clickhouse,
    projects,
    budget,
    now = Date.now,
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
    maxInFlightPerProject = DEFAULT_MAX_IN_FLIGHT_PER_PROJECT,
  } = options;
  const ipLimiter = new TokenBucketLimiter(options.ipLimit ?? DEFAULT_SERVER_IP_LIMIT, { now });
  /** The project each request's key names, found before its body is read. */
  const projectOf = new WeakMap<FastifyRequest, CollectingProject>();
  /** Requests in progress, with their project once its key is found, as OTLP counts them. */
  const inFlight = new Map<FastifyRequest, string | null>();
  const inFlightOf = new Map<string, number>();
  const finished = async (request: FastifyRequest) => {
    if (!inFlight.has(request)) return;
    const projectId = inFlight.get(request) ?? null;
    inFlight.delete(request);
    if (projectId === null) return;
    const left = (inFlightOf.get(projectId) ?? 1) - 1;
    if (left === 0) inFlightOf.delete(projectId);
    else inFlightOf.set(projectId, left);
  };

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation !== undefined || error.statusCode === 400) {
      return reply.code(400).send(problem("invalid_request", error.message));
    }
    if (error.statusCode === 413) {
      return reply
        .code(413)
        .send(
          problem("payload_too_large", `The body is larger than ${MAX_AI_CALLS_BODY_BYTES} bytes.`),
        );
    }
    if (error.statusCode === 415) {
      return reply
        .code(415)
        .send(problem("unsupported_media_type", "Send the batch as application/json."));
    }
    request.log.error({ err: error }, "unexpected error while collecting AI calls");
    return reply.code(500).send(problem("internal_error", "Something went wrong."));
  });

  app.post<{ Body: HttpAiBatch }>(
    "/ai-calls",
    {
      bodyLimit: MAX_AI_CALLS_BODY_BYTES,
      schema: { body: batchSchema },
      // Before the body is read, as OTLP's (telemetry/routes.ts): the key's
      // form, the address's rate, the requests in progress, and the key
      // itself (cached, unknown keys too), so a request that cannot be
      // stored is never read or parsed.
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
        if (inFlight.size >= maxInFlight) {
          return reply
            .code(503)
            .header("retry-after", "1")
            .send(problem("busy", "Too many requests are in progress. Try again shortly."));
        }
        // Taken before anything waits, so requests arriving together cannot
        // all pass the check; given back when the answer is sent.
        inFlight.set(request, null);
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
        const ofProject = inFlightOf.get(project.id) ?? 0;
        if (ofProject >= maxInFlightPerProject) {
          return reply
            .code(429)
            .header("retry-after", "1")
            .send(
              problem(
                "rate_limited",
                "Too many requests from this project are in progress. Try again shortly.",
              ),
            );
        }
        inFlight.set(request, project.id);
        inFlightOf.set(project.id, ofProject + 1);
        projectOf.set(request, project);
        return undefined;
      },
      onResponse: finished,
      onRequestAbort: finished,
    },
    async (request, reply) => {
      const project = projectOf.get(request);
      if (project === undefined) {
        throw new Error("the AI calls onRequest hook must find its project first");
      }
      const invalid = (message: string) =>
        reply.code(400).send(problem("invalid_request", message));
      const receivedAt = now();
      const { release = "" } = request.body;
      if (!isStorableText(release)) return invalid("release contains an unpaired surrogate.");
      const environment = environmentOf(request.body.environment);

      const rows: Omit<AiCallRow, "project_id">[] = [];
      let tooOld = 0;
      for (const [index, call] of request.body.calls.entries()) {
        const texts = [
          call.provider,
          call.model,
          call.operation ?? "",
          call.errorType ?? "",
          call.userId ?? "",
          call.feature ?? "",
          call.service ?? "",
          ...(call.finishReasons ?? []),
        ];
        if (!texts.every(isStorableText)) {
          return invalid(
            `calls[${index}] contains a NUL character or an unpaired surrogate, which cannot be stored.`,
          );
        }
        const provider = cleanLabel(call.provider);
        const model = cleanLabel(call.model);
        if (provider === "" || model === "") {
          return invalid(`calls[${index}]: provider and model must not be blank.`);
        }
        const errorType = cleanLabel(call.errorType, MAX_AI_ERROR_TYPE_CHARS);
        if (call.ok === true && errorType !== "") {
          return invalid(`calls[${index}]: a call with an errorType failed; leave out ok.`);
        }
        if (call.spanId !== undefined && call.traceId === undefined) {
          return invalid(`calls[${index}]: a spanId needs its traceId.`);
        }
        if (call.occurredAt > receivedAt + MAX_FUTURE_MS) {
          return invalid(`calls[${index}].occurredAt is in the future: check the server's clock.`);
        }
        if (receivedAt - call.occurredAt > MAX_EVENT_AGE_MS) {
          tooOld += 1;
          continue;
        }
        rows.push({
          timestamp: nanosText(BigInt(call.occurredAt) * 1_000_000n),
          // A UUID, never a span's 48 hex characters: no call sent here
          // can replace one found in a span.
          id: call.id.toLowerCase(),
          trace_id: call.traceId?.toLowerCase() ?? "",
          span_id: call.spanId?.toLowerCase() ?? "",
          service: cleanLabel(call.service),
          environment,
          release,
          provider,
          model,
          operation: cleanLabel(call.operation),
          feature: cleanLabel(call.feature),
          user_id: call.userId ?? "",
          input_tokens: call.inputTokens ?? 0,
          output_tokens: call.outputTokens ?? 0,
          cache_read_tokens: call.cacheReadTokens ?? 0,
          cache_write_tokens: call.cacheWriteTokens ?? 0,
          reasoning_tokens: call.reasoningTokens ?? 0,
          duration_ns: nanosOf(call.durationMs),
          first_chunk_ns: call.firstChunkMs === undefined ? null : nanosOf(call.firstChunkMs),
          failed: call.ok === false || errorType !== "",
          error_type: errorType,
          finish_reasons: (call.finishReasons ?? [])
            .map((reason) => cleanLabel(reason, MAX_FINISH_REASON_CHARS).toLowerCase())
            .filter((reason) => reason !== ""),
        });
      }

      if (rows.length > budget.capacity) {
        return reply
          .code(413)
          .send(
            problem(
              "payload_too_large",
              `A batch may hold at most ${budget.capacity} calls. Send smaller batches.`,
            ),
          );
      }
      const spent = budget.take(project.id, rows.length);
      if (!spent.allowed) {
        return reply
          .code(429)
          .header("retry-after", String(spent.retryAfterSeconds))
          .send(
            problem(
              "rate_limited",
              `Too many calls. Retry after ${spent.retryAfterSeconds} seconds.`,
            ),
          );
      }
      try {
        await insertRows(
          clickhouse,
          AI_CALLS_TABLE,
          rows.map((row) => ({ project_id: project.id, ...row })),
        );
      } catch (error) {
        // Not the sender's doing: the budget back, so its retries are not refused for it.
        budget.refund(project.id, rows.length);
        request.log.error({ err: error }, "could not store AI calls");
        return storageUnavailable(reply);
      }
      return reply.code(202).send({ stored: rows.length, tooOld });
    },
  );

  done();
};
