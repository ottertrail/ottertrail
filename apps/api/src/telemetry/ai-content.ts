/**
 * AI prompts and completions, which Ottertrail never stores
 * (docs/telemetry.md, "AI prompts and completions are not stored"):
 * the attributes several AI instrumentations record them in, by default
 * in some (the Vercel AI SDK, OpenLLMetry, OpenInference), and the GenAI
 * log events whose body holds a message. normalize.ts leaves them out of
 * spans, span events, span links, and log records, and counts them as
 * dropped. It applies to every project and cannot be turned off.
 *
 * Every name is taken from its library's own conventions or source:
 * - OpenTelemetry GenAI: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md
 *   and, for the deprecated names and events,
 *   https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/gen-ai.md
 *   and https://github.com/open-telemetry/semantic-conventions/blob/v1.36.0/docs/gen-ai/gen-ai-events.md
 * - Vercel AI SDK: https://ai-sdk.dev/docs/ai-sdk-core/telemetry and the
 *   attributes it records only with recordInputs or recordOutputs in
 *   https://github.com/vercel/ai/blob/main/packages/otel/src/legacy-open-telemetry.ts
 *   and https://github.com/vercel/ai/blob/main/packages/otel/src/open-telemetry.ts
 * - OpenLLMetry (Traceloop): https://github.com/traceloop/openllmetry/blob/main/packages/opentelemetry-semantic-conventions-ai/opentelemetry/semconv_ai/__init__.py
 *   (and v0.10.0's, for llm.prompts and llm.completions)
 * - OpenInference (Arize): https://github.com/Arize-ai/openinference/blob/main/spec/attributes/semantic-conventions.md
 *   and what its settings hide: https://github.com/Arize-ai/openinference/blob/main/spec/configuration/trace-config.md
 *
 * Kept, for the AI usage page: token counts (gen_ai.usage.*,
 * llm.token_count.*, ai.usage.*), model, provider, and operation names,
 * finish reasons, error.type, gen_ai.agent.name, gen_ai.tool.name,
 * gen_ai.conversation.id, and IDs such as gen_ai.tool.call.id.
 */

/** Attributes dropped by their exact name. */
const EXACT = [
  // OpenTelemetry GenAI.
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.prompt.variables",
  "gen_ai.retrieval.query.text",
  // OpenTelemetry GenAI, deprecated; OpenLLMetry's too.
  "gen_ai.prompt",
  "gen_ai.completion",
  // Vercel AI SDK.
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.tools",
  "ai.request.text",
  "ai.response.text",
  "ai.response.reasoning",
  "ai.response.object",
  "ai.response.toolCalls",
  "ai.response.files",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "ai.value",
  "ai.values",
  "ai.embedding",
  "ai.embeddings",
  "ai.documents",
  "ai.ranking",
  // OpenLLMetry.
  "traceloop.entity.input",
  "traceloop.entity.output",
  "traceloop.prompt.template",
  "gen_ai.task.input",
  "gen_ai.task.output",
  "mcp.request.argument",
  "mcp.response.value",
  // OpenInference.
  "input.value",
  "output.value",
  "llm.prompt_template.template",
  "llm.prompt_template.variables",
  "llm.function_call",
  "tool.parameters",
  "tool.json_schema",
  "reranker.query",
];

/** Attributes dropped with every attribute under them: "x" drops "x" and "x.…". */
const TREES = [
  // OpenTelemetry GenAI.
  "gen_ai.memory",
  // Vercel AI SDK.
  "ai.decision",
  "ai.extraction",
  // OpenLLMetry.
  "traceloop.prompt.template_variables",
  "llm.request.functions",
  "llm.completions",
  // OpenInference; llm.prompts is OpenLLMetry's older name too.
  "llm.input_messages",
  "llm.output_messages",
  "llm.prompts",
  "llm.choices",
  "llm.tools",
  "input.images",
  "input.documents",
  "output.images",
  "output.documents",
  "embedding.embeddings",
  "retrieval.documents",
  "reranker.input_documents",
  "reranker.output_documents",
];

/**
 * Attributes dropped when the part after them is a number, as in
 * OpenLLMetry's gen_ai.prompt.0.content and gen_ai.completion.0.tool_calls.0.arguments,
 * but for a finish reason (gen_ai.completion.0.finish_reason). Names such
 * as gen_ai.prompt.name and gen_ai.prompt.version are kept.
 */
const INDEXED = ["gen_ai.prompt", "gen_ai.completion"];
const FINISH_REASON = ".finish_reason";

/**
 * GenAI log events whose body is a message (OpenTelemetry's semantic
 * conventions up to v1.36.0), and the one that holds a call's messages in
 * its attributes: their body is dropped too.
 */
const CONTENT_EVENTS = new Set([
  "gen_ai.system.message",
  "gen_ai.user.message",
  "gen_ai.assistant.message",
  "gen_ai.tool.message",
  "gen_ai.choice",
  "gen_ai.client.inference.operation.details",
]);

const EXACT_SET = new Set([...EXACT, ...TREES]);
const TREE_SET = new Set(TREES);
const INDEXED_SET = new Set(INDEXED);

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

/** Whether an attribute holds AI prompt or completion content, by its name alone. */
export function isAiContent(key: string): boolean {
  if (EXACT_SET.has(key)) return true;
  for (let dot = key.indexOf("."); dot !== -1; dot = key.indexOf(".", dot + 1)) {
    const head = key.slice(0, dot);
    if (TREE_SET.has(head)) return true;
    if (INDEXED_SET.has(head) && isDigit(key.charCodeAt(dot + 1)) && !key.endsWith(FINISH_REASON)) {
      return true;
    }
  }
  return false;
}

/** Whether a log event's body is AI prompt or completion content, by the event's name. */
export function isAiContentEvent(name: string): boolean {
  return CONTENT_EVENTS.has(name);
}
