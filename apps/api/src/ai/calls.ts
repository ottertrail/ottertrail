import { MAX_ERROR_TYPE_CHARS, userIdOf } from "../telemetry/exceptions.ts";
import { cutChars, label, type SpanRow } from "../telemetry/normalize.ts";

/**
 * Extracts model calls from stored spans after prompt and completion filtering
 * (telemetry/ai-content.ts; docs/ai-usage.md, "Detection"). Stable rows deduplicate retries in
 * ReplacingMergeTree and are written alongside spans (telemetry/routes.ts).
 */

/**
 * GenAI model-call operations. Excludes agent, workflow, tool, and retrieval spans to avoid
 * counting nested calls' tokens twice.
 */
export const INFERENCE_OPERATIONS: ReadonlySet<string> = new Set([
  "chat",
  "generate_content",
  "text_completion",
  "realtime_inference",
  "embeddings",
]);

export const MAX_AI_LABEL_CHARS = 100;
/** Matches error-event type limits. */
export const MAX_AI_ERROR_TYPE_CHARS = MAX_ERROR_TYPE_CHARS;
/** Excess token counts are omitted; the call is kept. */
export const MAX_TOKENS = 1_000_000_000;
/** Each reason is capped at MAX_FINISH_REASON_CHARS. */
export const MAX_FINISH_REASONS = 16;
export const MAX_FINISH_REASON_CHARS = 64;
/** Longer IDs are discarded. */
export const MAX_CONVERSATION_ID_CHARS = 200;
/** Trimmed IDs exclude C0, DEL, and C1 controls. Length uses code points, matching Ajv. */
export const CONVERSATION_ID_PATTERN = `^[^\\u0000-\\u001F\\u007F-\\u009F]{1,${MAX_CONVERSATION_ID_CHARS}}$`;
const CONVERSATION_ID = new RegExp(CONVERSATION_ID_PATTERN, "u");
const CONVERSATION_ID_LENGTH = new RegExp(`^[\\s\\S]{0,${MAX_CONVERSATION_ID_CHARS}}$`, "u");

/** Tests code-point length; callers trim first. */
export const conversationIdFits = (id: string) => CONVERSATION_ID_LENGTH.test(id);
/** Reject times to first chunk over one day. */
const MAX_FIRST_CHUNK_SECONDS = 86_400;

/** First present name wins: current GenAI names before older aliases. */
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
  /**
   * The Vercel AI SDK's `functionId`: `gen_ai.agent.name` from AI SDK 7's OpenTelemetry
   * integration, `ai.telemetry.functionId` from LegacyOpenTelemetry and AI SDK 5 and 6.
   */
  agent: ["gen_ai.agent.name", "ai.telemetry.functionId"],
  conversation: ["gen_ai.conversation.id"],
} as const;

/** ai_calls schema: clickhouse/migrations.ts, 0008. */
export interface AiCallRow {
  project_id: string;
  timestamp: string;
  /** Uses the span row ID so retries deduplicate. */
  id: string;
  trace_id: string;
  span_id: string;
  service: string;
  environment: string;
  release: string;
  provider: string;
  model: string;
  operation: string;
  /** "" appears as "Unlabeled" in reports. */
  feature: string;
  user_id: string;
  /** App-defined ID (conversationIdOf); "" if absent. */
  conversation_id: string;
  input_tokens: number;
  /** See inputIncludesCache. */
  input_includes_cache: boolean;
  output_tokens: number;
  /** See outputIncludesReasoningByDefault. */
  output_includes_reasoning: boolean;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  duration_ns: string;
  first_chunk_ns: string | null;
  failed: boolean;
  error_type: string;
  finish_reasons: string[];
}

/**
 * GenAI input SHOULD include cache reads and writes (OpenLLMetry adds them for Anthropic). HTTP
 * calls use stated behavior or inputIncludesCacheByDefault. Input smaller than cached tokens
 * treats them separately regardless of `stated` (docs/ai-usage.md, "Cost").
 */
export function inputIncludesCache(
  stated: boolean,
  input: number,
  cacheRead: number,
  cacheWrite: number,
): boolean {
  return stated && input >= cacheRead + cacheWrite;
}

/**
 * Anthropic and Claude on Vertex AI report cached tokens separately. So do Bedrock's Converse API
 * (for every model) and InvokeModel for Claude (Anthropic's body). InvokeModel for OpenAI's models
 * and Bedrock's Responses API return OpenAI's form, which includes them, but an HTTP call does not
 * say which Bedrock API it used: `aws.bedrock` takes Converse's rule, and a Responses call sends
 * `inputIncludesCache: true`. A call through OpenAI's SDK on Bedrock's OpenAI-compatible endpoint
 * is sent as `openai`. OpenAI, Gemini, and other providers default to inclusive counts.
 */
export function inputIncludesCacheByDefault(provider: string, model: string): boolean {
  const name = provider.toLowerCase();
  const id = model.toLowerCase();
  if (name === "anthropic" || name === "aws.bedrock") return false;
  if (name === "gcp.vertex_ai") return !id.includes("claude");
  return true;
}

function first(attributes: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = attributes[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Strips controls, trims, and caps labels at `max` characters. */
export function cleanLabel(value: string | undefined, max = MAX_AI_LABEL_CHARS): string {
  return value === undefined ? "" : cutChars(label(value).trim(), max).trim();
}

/** Only whole counts from 0 to MAX_TOKENS are accepted. */
function tokens(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]{1,10}$/.test(value)) return null;
  const count = Number(value);
  return count <= MAX_TOKENS ? count : null;
}

/** Accepts a JSON list or one reason; normalizes to lowercase. */
function finishReasonsOf(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  let reasons: unknown[] = [value];
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) reasons = parsed;
    } catch {
      // Malformed lists fall back to the original reason.
    }
  }
  return reasons
    .flatMap((reason) => (typeof reason === "string" ? [reason] : []))
    .map((reason) => cleanLabel(reason, MAX_FINISH_REASON_CHARS).toLowerCase())
    .filter((reason) => reason !== "")
    .slice(0, MAX_FINISH_REASONS);
}

/** Converts seconds to nanosecond text; null for invalid or absent values. */
function firstChunkNs(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_FIRST_CHUNK_SECONDS) return null;
  return Math.round(seconds * 1e9).toString();
}

/**
 * Rejects invalid or overlong IDs instead of truncating, so distinct conversations cannot merge.
 * Stores only the app-defined identifier.
 */
export function conversationIdOf(value: string | undefined): string {
  const id = value?.trim() ?? "";
  return id.isWellFormed() && CONVERSATION_ID.test(id) ? id : "";
}

/** Parent operations reuse nested model-call tokens; exclude them to avoid double-counting. */
export const NOT_INFERENCE_OPERATIONS: ReadonlySet<string> = new Set([
  "invoke_agent",
  "create_agent",
  "invoke_workflow",
  "execute_tool",
  "plan",
  "retrieval",
]);

/**
 * Accepts inference/embeddings operations, or provider plus token counts for older/unknown
 * operations. Excludes NOT_INFERENCE_OPERATIONS.
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

/** Aliases for counts copied from Gemini's API over HTTP. */
const GEMINI_API_PROVIDERS = new Set(["gcp.gemini", "gcp.gen_ai", "gemini", "google"]);
const VERTEX_PROVIDERS = new Set(["gcp.vertex_ai", "vertex_ai"]);

/**
 * OpenAI and Anthropic include reasoning in output counts. Gemini's API and Vertex AI report
 * thoughts separately (totalTokenCount sums candidatesTokenCount and thoughtsTokenCount, per each
 * one's API reference) and bill them as output. Vercel's Google providers add thoughts to
 * outputTokens; other providers default to inclusive counts.
 */
export function outputIncludesReasoningByDefault(provider: string, model: string): boolean {
  const name = provider.toLowerCase();
  const gemini = model.toLowerCase().includes("gemini");
  if (GEMINI_API_PROVIDERS.has(name)) return name === "google" ? !gemini : false;
  if (VERTEX_PROVIDERS.has(name)) return !gemini;
  return true;
}

/** Returns null for spans without a model call. */
export function aiCallOf(span: SpanRow): AiCallRow | null {
  const { attributes } = span;
  if (!isAiCall(attributes)) return null;
  const count = (names: readonly string[]) => tokens(first(attributes, names)) ?? 0;
  const input = count(AI_ATTRIBUTES.inputTokens);
  const cacheRead = count(AI_ATTRIBUTES.cacheReadTokens);
  const cacheWrite = count(AI_ATTRIBUTES.cacheWriteTokens);
  const errorType = cleanLabel(first(attributes, AI_ATTRIBUTES.errorType), MAX_AI_ERROR_TYPE_CHARS);
  const provider = cleanLabel(first(attributes, AI_ATTRIBUTES.provider));
  const model = cleanLabel(first(attributes, AI_ATTRIBUTES.model));
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
    provider,
    model,
    operation: cleanLabel(first(attributes, AI_ATTRIBUTES.operation)),
    feature,
    user_id: userIdOf(attributes) ?? "",
    conversation_id: conversationIdOf(first(attributes, AI_ATTRIBUTES.conversation)),
    input_tokens: input,
    input_includes_cache: inputIncludesCache(true, input, cacheRead, cacheWrite),
    output_tokens: count(AI_ATTRIBUTES.outputTokens),
    // GenAI counts include reasoning. OpenLLMetry and Vercel add Gemini thoughts; OpenTelemetry
    // Vertex AI reports none.
    output_includes_reasoning: true,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: count(AI_ATTRIBUTES.reasoningTokens),
    duration_ns: span.duration_ns,
    first_chunk_ns: firstChunkNs(first(attributes, AI_ATTRIBUTES.firstChunk)),
    // GenAI sets error.type only for failed calls.
    failed: span.status_code === 2 || errorType !== "",
    error_type: errorType,
    finish_reasons: finishReasonsOf(first(attributes, AI_ATTRIBUTES.finishReasons)),
  };
}

export function aiCallsOf(spans: readonly SpanRow[]): AiCallRow[] {
  return spans.flatMap((span) => aiCallOf(span) ?? []);
}
