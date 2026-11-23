import { context, SpanKind, trace } from "@opentelemetry/api";
import { OTLPLogExporter as JsonLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as ProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { isAiContent, isAiContentEvent } from "../src/telemetry/ai-content.ts";
import {
  MAX_ATTRIBUTES,
  normalizeLogs,
  normalizeMetrics,
  normalizeTraces,
} from "../src/telemetry/normalize.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, nowNs, secretKeyOf, storedRows } from "./helpers/telemetry.ts";

/**
 * AI prompts and completions are dropped at ingestion (ai-content.ts;
 * docs/telemetry.md): what each instrumentation family sends, through
 * OpenTelemetry's own exporters in both encodings, stored without its
 * content, with its metadata, and with the content counted as dropped.
 */

type Value = string | number | string[];

interface Family {
  name: string;
  /** Attributes the AI usage page needs, and others kept. */
  kept: Record<string, Value>;
  /** Prompt and completion content: dropped. */
  content: Record<string, Value>;
}

const FAMILIES: Family[] = [
  {
    name: "OpenTelemetry GenAI inference",
    kept: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.response.model": "gpt-5-2026-08-01",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 48,
      "gen_ai.usage.cache_read.input_tokens": 100,
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.conversation.id": "conv_1",
      "gen_ai.agent.name": "support-bot",
      "gen_ai.prompt.name": "greeting",
      "gen_ai.prompt.version": "3",
      "error.type": "timeout",
    },
    content: {
      "gen_ai.input.messages":
        '[{"role":"user","parts":[{"type":"text","content":"my card is 4111"}]}]',
      "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"ok"}]}]',
      "gen_ai.system_instructions": '[{"type":"text","content":"You are kind."}]',
      "gen_ai.tool.definitions": '[{"type":"function","name":"refund"}]',
      "gen_ai.prompt.variables": '{"user_name":"Alice"}',
      "gen_ai.retrieval.query.text": "refund policy",
      "gen_ai.memory.query.text": "dietary preferences",
      "gen_ai.memory.records": '[{"content":"likes tea"}]',
      // The deprecated forms.
      "gen_ai.prompt": "What is the capital of France?",
      "gen_ai.completion": "Paris.",
    },
  },
  {
    name: "OpenTelemetry GenAI tool call",
    kept: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "get_weather",
      "gen_ai.tool.call.id": "call_1",
      "gen_ai.tool.type": "function",
    },
    content: {
      "gen_ai.tool.call.arguments": '{"location":"Paris"}',
      "gen_ai.tool.call.result": '{"temperature":21}',
    },
  },
  {
    name: "Vercel AI SDK, legacy ai.* spans",
    kept: {
      "operation.name": "ai.generateText.doGenerate support",
      "ai.operationId": "ai.generateText.doGenerate",
      "ai.model.id": "claude-sonnet-5",
      "ai.model.provider": "anthropic.messages",
      "ai.telemetry.functionId": "support",
      "ai.usage.promptTokens": 30,
      "ai.usage.completionTokens": 12,
      "ai.response.finishReason": "stop",
      "ai.response.id": "msg_1",
      "ai.prompt.toolChoice": '{"type":"auto"}',
      "gen_ai.system": "anthropic.messages",
      "gen_ai.usage.input_tokens": 30,
    },
    content: {
      "ai.prompt": '{"prompt":"hello"}',
      "ai.prompt.messages": '[{"role":"user","content":"hello"}]',
      "ai.prompt.tools": '["{\\"name\\":\\"refund\\"}"]',
      "ai.response.text": "Hi there",
      "ai.response.reasoning": "The user greets me.",
      "ai.response.toolCalls": '[{"toolName":"refund","args":"{}"}]',
      "ai.response.object": '{"answer":"hi"}',
      "ai.toolCall.args": '{"order":7}',
      "ai.toolCall.result": '{"ok":true}',
      "ai.value": "embed me",
      "ai.values": ["embed me", "and me"],
      "ai.embedding": "[0.1,0.2]",
      "ai.decision.state": '{"ticket":"refund please"}',
      "ai.extraction.answers": '{"name":"Alice"}',
    },
  },
  {
    name: "OpenLLMetry",
    kept: {
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.usage.prompt_tokens": 9,
      "gen_ai.usage.completion_tokens": 3,
      "gen_ai.completion.0.finish_reason": "stop",
      "llm.request.type": "chat",
      "traceloop.span.kind": "workflow",
      "traceloop.workflow.name": "answer",
      "traceloop.entity.name": "answer",
    },
    content: {
      "gen_ai.prompt.0.role": "user",
      "gen_ai.prompt.0.content": "Tell me a joke about my boss",
      "gen_ai.prompt.1.tool_calls.0.arguments": '{"q":"boss"}',
      "gen_ai.completion.0.role": "assistant",
      "gen_ai.completion.0.content": "Here is one…",
      "llm.request.functions.0.name": "search",
      "traceloop.entity.input": '{"args":["my boss"]}',
      "traceloop.entity.output": '"a joke"',
      "traceloop.prompt.template": "Tell me a joke about {topic}",
      "traceloop.prompt.template_variables.topic": "my boss",
    },
  },
  {
    name: "OpenInference",
    kept: {
      "openinference.span.kind": "LLM",
      "llm.model_name": "gpt-4o",
      "llm.provider": "openai",
      "llm.system": "openai",
      "llm.token_count.prompt": 21,
      "llm.token_count.completion": 7,
      "llm.token_count.total": 28,
      "llm.finish_reason": "stop",
      "llm.prompt_template.version": "v1",
      "llm.invocation_parameters": '{"temperature":0}',
      "session.id": "s1",
      "user.id": "u1",
      "input.mime_type": "text/plain",
    },
    content: {
      "input.value": "What is my balance?",
      "output.value": "$12",
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": "What is my balance?",
      "llm.output_messages.0.message.content": "$12",
      "llm.prompts.0.prompt.text": "def fib(n):",
      "llm.choices.0.completion.text": " return n",
      "llm.tools.0.tool.json_schema": '{"name":"balance"}',
      "llm.prompt_template.template": "Balance for {user}",
      "llm.prompt_template.variables": '{"user":"Alice"}',
      "embedding.embeddings.0.embedding.text": "hello world",
      "retrieval.documents.0.document.content": "Alice's statement",
      "input.images.0.image.url": "data:image/png;base64,AAAA",
      "tool.parameters": '{"a":"int"}',
    },
  },
];

/** Attributes as a span or record has them in a row: text, a list as JSON. */
function asStored(values: Record<string, Value>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      Array.isArray(value) ? JSON.stringify(value) : String(value),
    ]),
  );
}

describe("which names are content", () => {
  test.each(FAMILIES.flatMap((family) => Object.keys(family.content)))("%s is dropped", (key) => {
    expect(isAiContent(key)).toBe(true);
  });

  test.each([
    ...FAMILIES.flatMap((family) => Object.keys(family.kept)),
    "gen_ai.usage.cache_write.input_tokens",
    "gen_ai.input.messages_ref",
    "gen_ai.prompt.version",
    "gen_ai.prompted",
    "gen_ai.prompt.x.content",
    "llm.token_count.prompt_details.cache_read",
    "input.valued",
    "ai.response.providerMetadata",
    "http.route",
  ])("%s is kept", (key) => {
    expect(isAiContent(key)).toBe(false);
  });

  test("the GenAI events whose body is a message", () => {
    expect(
      [
        "gen_ai.system.message",
        "gen_ai.user.message",
        "gen_ai.assistant.message",
        "gen_ai.tool.message",
        "gen_ai.choice",
        "gen_ai.client.inference.operation.details",
      ].every(isAiContentEvent),
    ).toBe(true);
    expect(isAiContentEvent("gen_ai.evaluation.result")).toBe(false);
    expect(isAiContentEvent("")).toBe(false);
  });
});

describe("normalizing", () => {
  const PROJECT = "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11";
  const NOW = nowNs();
  const normalizeContext = { projectId: PROJECT, receivedAtNs: NOW, retentionDays: 30 };
  const record = (overrides: object) => ({
    timeUnixNano: String(NOW - 1_000_000_000n),
    ...overrides,
  });

  test(`content takes none of a span's ${MAX_ATTRIBUTES} places, and adds to the sender's dropped count`, () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_ATTRIBUTES }, (_, i) => [`k${i}`, "v"]),
    );
    const { rows } = normalizeTraces(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "5b8efff798038103d269b633813fc60c",
                    spanId: "eee19b7ec3c1b174",
                    name: "chat gpt-5",
                    startTimeUnixNano: String(NOW - 1_000_000_000n),
                    endTimeUnixNano: String(NOW),
                    attributes: keyValues({
                      "gen_ai.input.messages": "secret",
                      ...many,
                      "gen_ai.output.messages": "secret",
                    }),
                    droppedAttributesCount: 3,
                  },
                ],
              },
            ],
          },
        ],
      },
      normalizeContext,
    );
    expect(Object.keys(rows[0]?.attributes ?? {})).toHaveLength(MAX_ATTRIBUTES);
    expect(rows[0]?.attributes["k127"]).toBe("v");
    expect(rows[0]?.dropped_attributes_count).toBe(5);
  });

  test("a resource's content is dropped too, from every signal's rows", () => {
    const resource = {
      attributes: keyValues({
        "service.name": "chat",
        "gen_ai.prompt": "secret",
        "ai.prompt": "x",
      }),
    };
    const spans = normalizeTraces(
      {
        resourceSpans: [
          {
            resource,
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "5b8efff798038103d269b633813fc60c",
                    spanId: "eee19b7ec3c1b174",
                    startTimeUnixNano: String(NOW - 1_000_000_000n),
                    endTimeUnixNano: String(NOW),
                  },
                ],
              },
            ],
          },
        ],
      },
      normalizeContext,
    ).rows;
    const logs = normalizeLogs(
      { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [record({})] }] }] },
      normalizeContext,
    ).rows;
    const { points } = normalizeMetrics(
      {
        resourceMetrics: [
          {
            resource,
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "g",
                    gauge: {
                      dataPoints: [{ timeUnixNano: String(NOW - 1_000_000_000n), asDouble: 1 }],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      normalizeContext,
    );
    for (const row of [...spans, ...logs, ...points]) {
      expect(row.resource_attributes).toEqual({ "service.name": "chat" });
      expect(row.service).toBe("chat");
    }
    expect(spans.length + logs.length + points.length).toBe(3);
  });

  test("a GenAI message event's body is dropped, and counted; an empty one is not counted", () => {
    const { rows } = normalizeLogs(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  record({ eventName: "gen_ai.user.message", body: { stringValue: "secret" } }),
                  record({
                    attributes: keyValues({ "event.name": "gen_ai.choice" }),
                    body: { kvlistValue: { values: keyValues({ content: "secret" }) } },
                  }),
                  record({ eventName: "gen_ai.choice" }),
                  record({ eventName: "payment.failed", body: { stringValue: "card declined" } }),
                ],
              },
            ],
          },
        ],
      },
      normalizeContext,
    );
    expect(rows.map((row) => [row.body, row.dropped_attributes_count])).toEqual([
      ["", 1],
      ["", 1],
      ["", 0],
      ["card declined", 0],
    ]);
  });
});

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let baseUrl = "";

beforeAll(async () => {
  dashboard = await signedInDashboard();
  baseUrl = await dashboard.app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await dashboard?.close();
});

const RESOURCE = resourceFromAttributes({ "service.name": "ai-app" });

interface ExportResult {
  code: number;
  error?: Error;
}

function exported(exportWith: (done: (result: ExportResult) => void) => void) {
  return new Promise<ExportResult>((resolve) => {
    exportWith(resolve);
  });
}

async function newProject(name: string) {
  const project = await insertProject(dashboard.db, { name });
  return { id: project.id, key: await secretKeyOf(dashboard.db, project.id) };
}

function options(path: string, key: string) {
  return { url: `${baseUrl}${path}`, headers: { Authorization: `Bearer ${key}` } };
}

/** A span per family, with a span event and a link that carry content too. */
async function recordSpans(): Promise<ReadableSpan[]> {
  const memory = new InMemorySpanExporter();
  const provider = new TracerProvider({
    resource: RESOURCE,
    spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
  });
  const tracer = provider.getTracer("ai-test");
  const root = tracer.startSpan("invoke_agent support-bot", { kind: SpanKind.INTERNAL });
  const parent = trace.setSpan(context.active(), root);
  for (const family of FAMILIES) {
    const span = tracer.startSpan(
      family.name,
      {
        kind: SpanKind.CLIENT,
        attributes: { ...family.kept, ...family.content },
        links: [
          {
            context: root.spanContext(),
            attributes: { "gen_ai.input.messages": "secret", "link.reason": "retry" },
          },
        ],
      },
      parent,
    );
    // The older GenAI conventions' prompt event, which OpenLLMetry also sends.
    span.addEvent("gen_ai.content.prompt", {
      "gen_ai.prompt": "secret",
      "gen_ai.system": "openai",
    });
    span.end();
  }
  root.end();
  await provider.forceFlush();
  const spans = memory.getFinishedSpans();
  await provider.shutdown();
  return spans;
}

async function recordLogs(): Promise<ReadableLogRecord[]> {
  const memory = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    resource: RESOURCE,
    processors: [new SimpleLogRecordProcessor({ exporter: memory })],
  });
  const logger = provider.getLogger("ai-test");
  // The events of OpenTelemetry's GenAI conventions up to v1.36.0: the message is the body.
  logger.emit({
    eventName: "gen_ai.user.message",
    body: { content: "my password is hunter2" },
    attributes: { "gen_ai.system": "openai" },
  });
  // Older SDKs name the event in an attribute.
  logger.emit({
    body: { index: 0, finish_reason: "stop", message: { content: "Paris." } },
    attributes: { "event.name": "gen_ai.choice", "gen_ai.system": "openai" },
  });
  // The current conventions' event: the messages are attributes.
  logger.emit({
    eventName: "gen_ai.client.inference.operation.details",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.input.messages": '[{"role":"user"}]',
      "gen_ai.output.messages": '[{"role":"assistant"}]',
    },
  });
  // Any other record keeps its body; a content attribute is dropped all the same.
  logger.emit({
    body: "answered the question",
    attributes: { "traceloop.entity.output": "Paris.", "order.id": 7 },
  });
  await provider.forceFlush();
  const records = memory.getFinishedLogRecords();
  await provider.shutdown();
  return records;
}

describe.each(["http/protobuf", "http/json"] as const)(
  "OpenTelemetry's %s exporters",
  (protocol) => {
    const proto = protocol === "http/protobuf";

    test.each(FAMILIES.map((family) => [family.name, family] as const))(
      "%s: spans keep their metadata, not their content, and count it",
      async (name, family) => {
        const project = await newProject(`AI spans ${protocol} ${name}`);
        const spans = await recordSpans();
        const exporter = proto
          ? new ProtoTraceExporter(options("/v1/traces", project.key))
          : new JsonTraceExporter(options("/v1/traces", project.key));
        const result = await exported((done) => exporter.export(spans, done));
        await exporter.shutdown();
        expect(result.error).toBeUndefined();

        const rows = await storedRows(dashboard.reader.client, "spans", project.id);
        expect(rows).toHaveLength(FAMILIES.length + 1);
        const row = rows.find((stored) => stored.name === name);
        expect(row?.attributes).toEqual(asStored(family.kept));
        expect(row?.dropped_attributes_count).toBe(Object.keys(family.content).length);
        expect(JSON.parse(String(row?.events))).toMatchObject([
          { name: "gen_ai.content.prompt", attributes: { "gen_ai.system": "openai" } },
        ]);
        expect(JSON.parse(String(row?.events))[0].attributes).not.toHaveProperty("gen_ai.prompt");
        expect(JSON.parse(String(row?.links))).toMatchObject([
          { attributes: { "link.reason": "retry" } },
        ]);
        expect(String(row?.links)).not.toContain("secret");
        expect(String(row?.events)).not.toContain("secret");
      },
    );

    test("log records keep their metadata, not their content, and count it", async () => {
      const project = await newProject(`AI logs ${protocol}`);
      const records = await recordLogs();
      const exporter = proto
        ? new ProtoLogExporter(options("/v1/logs", project.key))
        : new JsonLogExporter(options("/v1/logs", project.key));
      const result = await exported((done) => exporter.export(records, done));
      await exporter.shutdown();
      expect(result.error).toBeUndefined();

      const rows = await storedRows(dashboard.reader.client, "logs", project.id);
      expect(rows).toHaveLength(4);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_name: "gen_ai.user.message",
            body: "",
            attributes: { "gen_ai.system": "openai" },
            dropped_attributes_count: 1,
          }),
          expect.objectContaining({
            event_name: "",
            body: "",
            attributes: { "event.name": "gen_ai.choice", "gen_ai.system": "openai" },
            dropped_attributes_count: 1,
          }),
          expect.objectContaining({
            event_name: "gen_ai.client.inference.operation.details",
            body: "",
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.request.model": "gpt-5",
              "gen_ai.usage.input_tokens": "120",
            },
            dropped_attributes_count: 2,
          }),
          expect.objectContaining({
            body: "answered the question",
            attributes: { "order.id": "7" },
            dropped_attributes_count: 1,
          }),
        ]),
      );
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain("hunter2");
      expect(stored).not.toContain("Paris.");
    });
  },
);
