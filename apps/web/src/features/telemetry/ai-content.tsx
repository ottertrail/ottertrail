/** Match AI instrumentation metadata names. Drop prompts and completions at ingestion (docs/telemetry.md, "AI prompts and completions are not stored"). */
const AI_PREFIXES = ["gen_ai.", "ai.", "llm.", "traceloop.", "openinference."];

function isAiRecord(attributes: Record<string, string>, eventName = ""): boolean {
  const event = eventName === "" ? (attributes["event.name"] ?? "") : eventName;
  return (
    event.startsWith("gen_ai.") ||
    Object.keys(attributes).some((key) => AI_PREFIXES.some((prefix) => key.startsWith(prefix)))
  );
}

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
