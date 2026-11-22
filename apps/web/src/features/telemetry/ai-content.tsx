/**
 * The attribute names AI instrumentations record a call's metadata
 * under: the OpenTelemetry GenAI conventions, the Vercel AI SDK,
 * OpenLLMetry, and OpenInference. Their prompts and completions are
 * dropped when received (docs/telemetry.md, "AI prompts and completions
 * are not stored").
 */
const AI_PREFIXES = ["gen_ai.", "ai.", "llm.", "traceloop.", "openinference."];

/** Whether a span or log record came from an AI instrumentation. */
function isAiRecord(attributes: Record<string, string>, eventName = ""): boolean {
  const event = eventName === "" ? (attributes["event.name"] ?? "") : eventName;
  return (
    event.startsWith("gen_ai.") ||
    Object.keys(attributes).some((key) => AI_PREFIXES.some((prefix) => key.startsWith(prefix)))
  );
}

/** On an AI span or log record: why its prompt and completion are not there. */
export function AiContentNote({
  attributes,
  eventName,
}: {
  attributes: Record<string, string>;
  eventName?: string;
}) {
  if (!isAiRecord(attributes, eventName)) return null;
  return (
    <p className="text-xs text-ink-subtle">
      AI prompts and completions are removed before storing.
    </p>
  );
}
