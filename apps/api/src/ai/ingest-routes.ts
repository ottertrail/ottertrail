import type { FastifyError, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

import type { IngestActivity, IngestOutcome } from "../activity/activity.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { insertRows } from "../clickhouse/insert.ts";
import { AI_CALLS_TABLE } from "../clickhouse/migrations.ts";
import { clickHouseTime } from "../clickhouse/query.ts";
import { ENVIRONMENT_PATTERN, environmentOf, RELEASE_PATTERN } from "../collection/environment.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import { InFlight } from "../collection/in-flight.ts";
import { isStorableText, MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import type { CollectingProject, ProjectKeyCache } from "../collection/project-keys.ts";
import {
  clientKey,
  type EventBudget,
  type RateLimit,
  TokenBucketLimiter,
} from "../collection/rate-limiter.ts";
import { DEFAULT_SERVER_IP_LIMIT, MAX_FUTURE_MS } from "../collection/server-events.ts";
import { BUSY, SecretKeyLookups } from "../telemetry/key-lookups.ts";
import { nanosText } from "../telemetry/normalize.ts";
import { DEFAULT_MAX_IN_FLIGHT, DEFAULT_MAX_IN_FLIGHT_PER_PROJECT } from "../telemetry/routes.ts";
import {
  type AiCallRow,
  cleanLabel,
  conversationIdFits,
  conversationIdOf,
  inputIncludesCache,
  inputIncludesCacheByDefault,
  outputIncludesReasoningByDefault,
  MAX_AI_LABEL_CHARS,
  MAX_CONVERSATION_ID_CHARS,
} from "./calls.ts";

/** Calls in one request (docs/ai-usage.md, "Sending calls over HTTP"). */
export const MAX_AI_CALLS_PER_BATCH = 1000;
/** A request's body: 1,000 calls of usual size fit with room to spare. */
export const MAX_AI_CALLS_BODY_BYTES = 1024 * 1024;
/** A call's duration, and its time to the first chunk, at most a day. */
const MAX_CALL_MS = 86_400_000;
/** Tighter than a span's (calls.ts): real calls stay far below them. */
export const MAX_HTTP_TOKENS = 10_000_000;
export const MAX_HTTP_ERROR_TYPE_CHARS = 100;
/** One a choice: OpenAI's `n` and Gemini's `candidateCount` ask for several. */
export const MAX_HTTP_FINISH_REASONS = 16;
export const MAX_HTTP_FINISH_REASON_CHARS = 32;

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
/** A name such as a model's: no whitespace, control, format, or unassigned characters. */
const identifierOf = (max: number, min = 1) => ({
  type: "string",
  pattern: `^[^\\s\\p{C}]{${min},${max}}$`,
});
/**
 * Free text an app names things with: none of textOf's characters, nor
 * format characters (such as bidi overrides and zero-width ones) or line
 * and paragraph separators, which can hide or reorder what a page shows.
 */
const NO_FORMAT = "\\p{Cf}\\u2028\\u2029";
const labelOf = (max: number) => ({
  type: "string",
  pattern: `^[^\\p{Cc}${NO_FORMAT}]{0,${max}}$`,
});
/** An error's name, such as `RateLimitError` or `Too Many Requests`: identifier characters, words apart by one space. */
const ERROR_TYPE = {
  type: "string",
  maxLength: MAX_HTTP_ERROR_TYPE_CHARS,
  pattern: "^(?:[^\\s\\p{C}]+(?: [^\\s\\p{C}]+)*)?$",
};
const TOKENS = { type: "integer", minimum: 0, maximum: MAX_HTTP_TOKENS };
const MILLISECONDS = { type: "number", minimum: 0, maximum: MAX_CALL_MS };

interface HttpAiCall {
  id: string;
  /** When the call started, in milliseconds since 1970: the server's clock is trusted. */
  occurredAt: number;
  provider: string;
  model: string;
  operation?: string;
  inputTokens?: number;
  /** Whether inputTokens holds the cached tokens; by the provider when left out (calls.ts). */
  inputIncludesCache?: boolean;
  outputTokens?: number;
  /** Whether outputTokens holds the reasoning tokens; by the provider when left out (calls.ts). */
  outputIncludesReasoning?: boolean;
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
  /** The app's ID for the conversation the call is a turn of. */
  conversationId?: string;
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
          provider: identifierOf(MAX_AI_LABEL_CHARS),
          model: identifierOf(MAX_AI_LABEL_CHARS),
          operation: identifierOf(MAX_AI_LABEL_CHARS, 0),
          inputTokens: TOKENS,
          inputIncludesCache: { type: "boolean" },
          outputTokens: TOKENS,
          outputIncludesReasoning: { type: "boolean" },
          cacheReadTokens: TOKENS,
          cacheWriteTokens: TOKENS,
          reasoningTokens: TOKENS,
          durationMs: MILLISECONDS,
          firstChunkMs: MILLISECONDS,
          ok: { type: "boolean" },
          errorType: ERROR_TYPE,
          finishReasons: {
            type: "array",
            maxItems: MAX_HTTP_FINISH_REASONS,
            items: identifierOf(MAX_HTTP_FINISH_REASON_CHARS, 0),
          },
          userId: {
            type: "string",
            maxLength: 200,
            pattern: USER_ID_PATTERN,
            allOf: [{ pattern: `^[^${NO_FORMAT}]*$` }],
          },
          feature: labelOf(MAX_AI_LABEL_CHARS),
          // Its length is checked once trimmed (below), as a span's is.
          conversationId: labelOf(MAX_CONVERSATION_ID_CHARS * 4),
          service: optionalTextOf(MAX_AI_LABEL_CHARS),
          traceId: { type: "string", pattern: "^[0-9a-fA-F]{32}$" },
          spanId: { type: "string", pattern: "^[0-9a-fA-F]{16}$" },
        },
      },
    },
  },
};

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  integer: "a whole number",
  number: "a number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
};

function isOfType(value: unknown, type: string): boolean {
  if (type === "string" || type === "number" || type === "boolean") return typeof value === type;
  if (type === "integer") return Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  return true;
}

interface TypedSchema {
  [keyword: string]: unknown;
  type?: string;
  properties?: Record<string, TypedSchema>;
  items?: TypedSchema;
}

/**
 * The first value not of its schema's type as sent, or null. Fastify's
 * Ajv coerces types (app.ts), so `"ok": null` would pass as false and a
 * token count of "5" as 5; this route takes JSON types as they are.
 */
function typeProblem(value: unknown, schema: TypedSchema, path: string): string | null {
  if (value === undefined) return null;
  if (schema.type !== undefined && !isOfType(value, schema.type)) {
    return `${path === "" ? "The body" : path} must be ${TYPE_NAMES[schema.type] ?? schema.type}.`;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      const found = typeProblem(item, schema.items, `${path}[${index}]`);
      if (found !== null) return found;
    }
  } else if (typeof value === "object" && value !== null && schema.properties !== undefined) {
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const item: unknown = Reflect.get(value, key);
      const found = typeProblem(item, property, path === "" ? key : `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

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
  /** Counts for the Activity tab (activity/activity.ts). */
  activity: IngestActivity;
  /** The telemetry budget, shared with OTLP (telemetry/routes.ts): each call is a unit. */
  budget: EventBudget;
  /** Requests per client address, an IPv6 address by its /64 (DEFAULT_SERVER_IP_LIMIT). */
  ipLimit?: RateLimit;
  /** Requests this process works on at once, and one project's of them, as OTLP's (telemetry/routes.ts). */
  maxInFlight?: number;
  maxInFlightPerProject?: number;
  /** Bounds key lookups, as OTLP's (telemetry/key-lookups.ts); this route's own by default. */
  keyLookups?: SecretKeyLookups;
  now?: () => number;
}

/**
 * POST /api/ai-calls (docs/ai-usage.md, "Sending calls over HTTP"): AI
 * calls an app's server sends itself, for apps without OpenTelemetry,
 * into the same ai_calls table as calls found in spans (calls.ts), so the
 * AI page and the alert rules read them unchanged.
 *
 * As OTLP's (telemetry/routes.ts), before the body is read: the secret
 * key's form, the address's rate, the key's project (cached, unknown keys
 * too), and the requests in progress. Then, as server events
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
    activity,
    budget,
    now = Date.now,
    keyLookups = new SecretKeyLookups(),
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
    maxInFlightPerProject = DEFAULT_MAX_IN_FLIGHT_PER_PROJECT,
  } = options;
  const ipLimiter = new TokenBucketLimiter(options.ipLimit ?? DEFAULT_SERVER_IP_LIMIT, { now });
  /** The project each request's key names, found before its body is read. */
  const projectOf = new WeakMap<FastifyRequest, CollectingProject>();
  /** Requests in progress, counted as OTLP's are (in-flight.ts). */
  const inFlight = new InFlight(maxInFlight, maxInFlightPerProject);
  /** Counts a request whose project is known (activity/activity.ts); others are not. */
  const count = (
    request: FastifyRequest,
    outcome: IngestOutcome,
    items = 0,
    project = projectOf.get(request),
  ) => {
    if (project !== undefined) activity.add(project.id, "ai_calls", outcome, items);
  };

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // The key was read before the body: a body refused here is the project's.
    const status = error.validation === undefined ? (error.statusCode ?? 500) : 400;
    if (status >= 400 && status < 500) count(request, "refused_invalid");
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
      // form, the address's rate, the key itself (cached, unknown keys
      // too), and the requests in progress, so a request that cannot be
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
        // As OTLP's: the key before a slot, so made-up keys hold none.
        let project;
        try {
          project = await keyLookups.find(projects, secretKey, clientKey(request.ip));
        } catch (error) {
          request.log.error({ err: error }, "could not look up the secret key");
          return storageUnavailable(reply);
        }
        if (project === BUSY) {
          return reply
            .code(503)
            .header("retry-after", "1")
            .send(problem("busy", "Too many keys are being looked up. Try again shortly."));
        }
        if (project === null) {
          return reply.code(401).send(problem("unknown_key", "No project has this secret key."));
        }
        if (!inFlight.take(request, reply)) {
          return reply
            .code(503)
            .header("retry-after", "1")
            .send(problem("busy", "Too many requests are in progress. Try again shortly."));
        }
        if (!inFlight.takeForProject(request, project.id)) {
          count(request, "refused_rate_limited", 0, project);
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
        projectOf.set(request, project);
        return undefined;
      },
      // Before the schema, which would coerce what was sent.
      preValidation: async (request, reply) => {
        const found = typeProblem(request.body, batchSchema, "");
        if (found !== null) {
          count(request, "refused_invalid");
          return reply.code(400).send(problem("invalid_request", found));
        }
        // An error type's spaces at the ends, or several in a row, are a
        // sender's slip: tidied, not refused. Other whitespace still is.
        const { calls } = request.body as Partial<HttpAiBatch>;
        for (const call of Array.isArray(calls) ? calls : []) {
          if (typeof call?.errorType === "string") {
            call.errorType = call.errorType.replaceAll(/ {2,}/g, " ").trim();
          }
        }
        return undefined;
      },
      onResponse: inFlight.finished,
      onRequestAbort: inFlight.finished,
    },
    // The slot is held until the work settles, the insert included.
    async (request, reply) =>
      inFlight.run(request, async () => {
        const project = projectOf.get(request);
        if (project === undefined) {
          throw new Error("the AI calls onRequest hook must find its project first");
        }
        const invalid = (message: string) => {
          count(request, "refused_invalid");
          return reply.code(400).send(problem("invalid_request", message));
        };
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
            call.conversationId ?? "",
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
          const errorType = cleanLabel(call.errorType, MAX_HTTP_ERROR_TYPE_CHARS);
          if (call.ok === true && errorType !== "") {
            return invalid(`calls[${index}]: a call with an errorType failed; leave out ok.`);
          }
          const conversationId = call.conversationId?.trim() ?? "";
          if (!conversationIdFits(conversationId)) {
            return invalid(
              `calls[${index}].conversationId is longer than ${MAX_CONVERSATION_ID_CHARS} characters.`,
            );
          }
          if (call.firstChunkMs !== undefined && call.firstChunkMs > call.durationMs) {
            return invalid(`calls[${index}]: firstChunkMs is longer than durationMs.`);
          }
          if (call.spanId !== undefined && call.traceId === undefined) {
            return invalid(`calls[${index}]: a spanId needs its traceId.`);
          }
          if (call.occurredAt > receivedAt + MAX_FUTURE_MS) {
            return invalid(
              `calls[${index}].occurredAt is in the future: check the server's clock.`,
            );
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
            conversation_id: conversationIdOf(conversationId),
            input_tokens: call.inputTokens ?? 0,
            input_includes_cache: inputIncludesCache(
              call.inputIncludesCache ?? inputIncludesCacheByDefault(provider, model),
              call.inputTokens ?? 0,
              call.cacheReadTokens ?? 0,
              call.cacheWriteTokens ?? 0,
            ),
            output_tokens: call.outputTokens ?? 0,
            output_includes_reasoning:
              call.outputIncludesReasoning ?? outputIncludesReasoningByDefault(provider, model),
            cache_read_tokens: call.cacheReadTokens ?? 0,
            cache_write_tokens: call.cacheWriteTokens ?? 0,
            reasoning_tokens: call.reasoningTokens ?? 0,
            duration_ns: nanosOf(call.durationMs),
            first_chunk_ns: call.firstChunkMs === undefined ? null : nanosOf(call.firstChunkMs),
            failed: call.ok === false || errorType !== "",
            error_type: errorType,
            finish_reasons: (call.finishReasons ?? [])
              .map((reason) => cleanLabel(reason, MAX_HTTP_FINISH_REASON_CHARS).toLowerCase())
              .filter((reason) => reason !== ""),
          });
        }

        if (rows.length > budget.capacity) {
          count(request, "refused_invalid");
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
          count(request, spent.limit === "instance" ? "refused_volume" : "refused_rate_limited");
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
            rows.map((row) => ({
              project_id: project.id,
              received_at: clickHouseTime(new Date(receivedAt)),
              ...row,
            })),
          );
        } catch (error) {
          // Not the sender's doing: the budget back, so its retries are not refused for it.
          budget.refund(project.id, rows.length);
          request.log.error({ err: error }, "could not store AI calls");
          count(request, "refused_unavailable");
          return storageUnavailable(reply);
        }
        // Per call: those stored, and those too old to store.
        if (rows.length > 0) count(request, "accepted", rows.length);
        if (tooOld > 0) count(request, "filtered_too_old", tooOld);
        return reply.code(202).send({ stored: rows.length, tooOld });
      }),
  );

  done();
};
