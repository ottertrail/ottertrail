import { MAX_ERROR_TYPE_CHARS, userIdOf } from "../telemetry/exceptions.ts";
import { cutChars, label, type SpanRow } from "../telemetry/normalize.ts";

/**
 * AI calls (docs/ai-usage.md, "Detection"): the spans of a traces request
 * that record one call to a model, as rows of the ai_calls table, written
 * beside the spans (telemetry/routes.ts), as a span's exceptions become
 * error events. Read from the span's row, after the prompts and
 * completions are dropped (telemetry/ai-content.ts), so nothing here
 * could keep them. A pure function of the span: a retried request gives
 * the same rows, which ReplacingMergeTree keeps once.
 */

/**
 * The operations that are one call to a model (OpenTelemetry's GenAI
 * conventions, `gen_ai.operation.name`). Agent, workflow, tool, and
 * retrieval spans are not: their tokens, when they carry any, are the
 * model calls' inside them, which are counted on their own.
 */
export const INFERENCE_OPERATIONS: ReadonlySet<string> = new Set([
  "chat",
  "generate_content",
  "text_completion",
  "realtime_inference",
  "embeddings",
]);

/** A model's, provider's, operation's, or feature's name is cut to this many characters. */
export const MAX_AI_LABEL_CHARS = 100;
/** `error.type` is cut to what an error event's type holds. */
export const MAX_AI_ERROR_TYPE_CHARS = MAX_ERROR_TYPE_CHARS;
/** A token count above this is refused: that count is left out of the call, the call kept. */
export const MAX_TOKENS = 1_000_000_000;
/** Finish reasons a call keeps, each cut to MAX_FINISH_REASON_CHARS. */
export const MAX_FINISH_REASONS = 16;
const MAX_FINISH_REASON_CHARS = 64;
/** A time to the first chunk above a day is not one. */
const MAX_FIRST_CHUNK_SECONDS = 86_400;

/**
 * Each value, read from the first of its names the span has: the current
 * GenAI names first, then the older ones instrumentations still send.
 */
export const AI_ATTRIBUTES = {
  operation: ["gen_ai.operation.name"],
  provider: ["gen_ai.provider.name", "gen_ai.system"],
  model: ["gen_ai.response.model", "gen_ai.request.model"],
  inputTokens: [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
    "llm.token_count.prompt",
  ],
  outputTokens: [
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
    "llm.token_count.completion",
  ],
  cacheReadTokens: [
    "gen_ai.usage.cache_read.input_tokens",
    "llm.token_count.prompt_details.cache_read",
  ],
  cacheWriteTokens: [
    "gen_ai.usage.cache_write.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "llm.token_count.prompt_details.cache_write",
  ],
  reasoningTokens: ["gen_ai.usage.reasoning.output_tokens"],
  finishReasons: ["gen_ai.response.finish_reasons"],
  firstChunk: ["gen_ai.response.time_to_first_chunk"],
  errorType: ["error.type"],
  feature: ["ottertrail.feature"],
  agent: ["gen_ai.agent.name"],
} as const;

/** One row of the ai_calls table (clickhouse/migrations.ts, 0008). */
export interface AiCallRow {
  project_id: string;
  /** The span's start, as the spans table has it. */
  timestamp: string;
  /** The trace and span IDs: the span's own row ID, so a retry is the same row. */
  id: string;
  trace_id: string;
  span_id: string;
  service: string;
  environment: string;
  release: string;
  provider: string;
  model: string;
  operation: string;
  /** "" when the span names none: "Unlabelled" in reports. */
  feature: string;
  /** "" for none. */
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  duration_ns: string;
  first_chunk_ns: string | null;
  failed: boolean;
  error_type: string;
  finish_reasons: string[];
}

/** The first of `names` the attributes have, as sent; undefined when none. */
function first(attributes: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = attributes[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A name as a report lists it: no control characters, trimmed, at most `max` characters. */
function cleanLabel(value: string | undefined, max = MAX_AI_LABEL_CHARS): string {
  return value === undefined ? "" : cutChars(label(value).trim(), max).trim();
}

/**
 * A token count: a whole number from 0 to MAX_TOKENS, as an integer
 * attribute is stored ("120"); anything else is no count.
 */
function tokens(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]{1,10}$/.test(value)) return null;
  const count = Number(value);
  return count <= MAX_TOKENS ? count : null;
}

/** Finish reasons: a list as JSON (how a string array is stored), or one reason; lower case. */
function finishReasonsOf(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  let reasons: unknown[] = [value];
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) reasons = parsed;
    } catch {
      // Not JSON: one reason, as sent.
    }
  }
  return reasons
    .flatMap((reason) => (typeof reason === "string" ? [reason] : []))
    .map((reason) => cleanLabel(reason, MAX_FINISH_REASON_CHARS).toLowerCase())
    .filter((reason) => reason !== "")
    .slice(0, MAX_FINISH_REASONS);
}

/** Seconds to the first chunk as nanoseconds, or null when absent or not a time. */
function firstChunkNs(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_FIRST_CHUNK_SECONDS) return null;
  return Math.round(seconds * 1e9).toString();
}

/**
 * The operations that are not a call to a model: agents, workflows, tools,
 * planning, and retrieval. Their tokens, when they carry any, are the
 * model calls' inside them.
 */
export const NOT_INFERENCE_OPERATIONS: ReadonlySet<string> = new Set([
  "invoke_agent",
  "create_agent",
  "invoke_workflow",
  "execute_tool",
  "plan",
  "retrieval",
]);

/**
 * Whether a span records one call to a model: its operation is an
 * inference or embeddings operation; or, unless it is one of the
 * operations that are not (NOT_INFERENCE_OPERATIONS), it names a provider
 * and a token count: an older sender that names no operation, or one
 * whose operation the conventions do not list.
 */
export function isAiCall(attributes: Record<string, string>): boolean {
  const operation = first(attributes, AI_ATTRIBUTES.operation);
  if (operation !== undefined && INFERENCE_OPERATIONS.has(operation)) return true;
  if (operation !== undefined && NOT_INFERENCE_OPERATIONS.has(operation)) return false;
  const provider = cleanLabel(first(attributes, AI_ATTRIBUTES.provider));
  return (
    provider !== "" &&
    (tokens(first(attributes, AI_ATTRIBUTES.inputTokens)) !== null ||
      tokens(first(attributes, AI_ATTRIBUTES.outputTokens)) !== null)
  );
}

/** The ai_calls row of a stored span, or null when the span is not an AI call. */
export function aiCallOf(span: SpanRow): AiCallRow | null {
  const { attributes } = span;
  if (!isAiCall(attributes)) return null;
  const count = (names: readonly string[]) => tokens(first(attributes, names)) ?? 0;
  const errorType = cleanLabel(first(attributes, AI_ATTRIBUTES.errorType), MAX_AI_ERROR_TYPE_CHARS);
  const feature =
    cleanLabel(first(attributes, AI_ATTRIBUTES.feature)) ||
    cleanLabel(first(attributes, AI_ATTRIBUTES.agent));
  return {
    project_id: span.project_id,
    timestamp: span.timestamp,
    id: span.id,
    trace_id: span.trace_id,
    span_id: span.span_id,
    service: span.service,
    environment: span.environment,
    release: span.release,
    provider: cleanLabel(first(attributes, AI_ATTRIBUTES.provider)),
    model: cleanLabel(first(attributes, AI_ATTRIBUTES.model)),
    operation: cleanLabel(first(attributes, AI_ATTRIBUTES.operation)),
    feature,
    user_id: userIdOf(attributes) ?? "",
    input_tokens: count(AI_ATTRIBUTES.inputTokens),
    output_tokens: count(AI_ATTRIBUTES.outputTokens),
    cache_read_tokens: count(AI_ATTRIBUTES.cacheReadTokens),
    cache_write_tokens: count(AI_ATTRIBUTES.cacheWriteTokens),
    reasoning_tokens: count(AI_ATTRIBUTES.reasoningTokens),
    duration_ns: span.duration_ns,
    first_chunk_ns: firstChunkNs(first(attributes, AI_ATTRIBUTES.firstChunk)),
    // Status Error (2), or an error.type, which the conventions set only when the call failed.
    failed: span.status_code === 2 || errorType !== "",
    error_type: errorType,
    finish_reasons: finishReasonsOf(first(attributes, AI_ATTRIBUTES.finishReasons)),
  };
}

/** The AI calls among a request's stored spans, in their order. */
export function aiCallsOf(spans: readonly SpanRow[]): AiCallRow[] {
  return spans.flatMap((span) => aiCallOf(span) ?? []);
}
