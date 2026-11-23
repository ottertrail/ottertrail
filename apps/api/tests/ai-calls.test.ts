import { randomBytes } from "node:crypto";

import { context, type Attributes, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  aiCallsOf,
  conversationIdOf,
  inputIncludesCacheByDefault,
  isAiCall,
  MAX_TOKENS,
} from "../src/ai/calls.ts";
import { buildApp } from "../src/app.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../src/config.ts";
import { normalizeTraces } from "../src/telemetry/normalize.ts";
import { TRACE_MESSAGES } from "../src/telemetry/proto/definitions.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { encodeProtobuf, keyValues, nowNs, secretKeyOf, storedRows } from "./helpers/telemetry.ts";
import { createTestClickHouse } from "./helpers/test-clickhouse.ts";

/**
 * Guard old and new AI attributes through both OpenTelemetry exporter encodings.
 * Retries stay one row; a 503 refunds the budget (docs/ai-usage.md, "Detection"; ai/calls.ts).
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let baseUrl = "";

beforeAll(async () => {
  dashboard = await signedInDashboard();
  baseUrl = await dashboard.app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await dashboard?.close();
});

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

async function newProject(name: string) {
  const project = await insertProject(dashboard.db, { name });
  return { id: project.id, key: await secretKeyOf(dashboard.db, project.id) };
}

/** A project's ai_calls rows, one per ID (FINAL), oldest first. */
async function storedCalls(projectId: string, final = true): Promise<Record<string, unknown>[]> {
  const result = await dashboard.reader.client.query({
    query: `SELECT * FROM ai_calls ${final ? "FINAL" : ""} WHERE project_id = {project:UUID}
            ORDER BY timestamp, id`,
    query_params: { project: projectId },
    format: "JSONEachRow",
  });
  return result.json();
}

interface SpanCase {
  name: string;
  attributes: Attributes;
  failed?: boolean;
}

const LONG_MODEL = `m${"o".repeat(150)}del`;

/** Spans as each kind of sender makes them. */
const SPANS: SpanCase[] = [
  {
    name: "chat claude-sonnet-4-6",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-6",
      "gen_ai.response.model": "claude-sonnet-4-6-20260601",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 300,
      "gen_ai.usage.cache_read.input_tokens": 800,
      "gen_ai.usage.cache_write.input_tokens": 100,
      "gen_ai.usage.reasoning.output_tokens": 120,
      "gen_ai.response.finish_reasons": ["end_turn", "MAX_TOKENS"],
      "gen_ai.response.time_to_first_chunk": 0.42,
      "gen_ai.agent.name": "ignored-agent",
      "ottertrail.feature": "support-chat",
      "user.id": "user-42",
      "gen_ai.conversation.id": "  conv_5Hx9-2026 ",
    },
  },
  {
    name: "openai.chat",
    // An older sender: no operation name, gen_ai.system, and the old token names.
    attributes: {
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.usage.prompt_tokens": 90,
      "gen_ai.usage.completion_tokens": 30,
      "gen_ai.usage.cache_creation.input_tokens": 40,
      "gen_ai.response.finish_reasons": "stop",
      "gen_ai.agent.name": "support-bot",
      "enduser.id": "user-old",
      // Longer than a conversation's ID may be: none, never cut into another's.
      "gen_ai.conversation.id": "c".repeat(201),
    },
  },
  {
    name: "embeddings text-embedding-3-small",
    attributes: {
      "gen_ai.operation.name": "embeddings",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "text-embedding-3-small",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.conversation.id": "c".repeat(200),
    },
  },
  {
    name: "generate_content gemini",
    failed: true,
    attributes: {
      "gen_ai.operation.name": "generate_content",
      "gen_ai.provider.name": "gcp.gemini",
      "gen_ai.request.model": LONG_MODEL,
      // Out of bounds: left out of the call, which is kept.
      "gen_ai.usage.input_tokens": -5,
      "gen_ai.usage.output_tokens": MAX_TOKENS + 1,
      "error.type": `quota\u0007_${"x".repeat(300)}`,
      "ottertrail.feature": "  \u0001  ",
      "gen_ai.agent.name": "summarizer",
      // Longer than a user ID may be: none.
      "user.id": "u".repeat(201),
      // A control character: none.
      "gen_ai.conversation.id": "conv\u0007one",
    },
  },
  // Not calls: an agent's span and a tool's carry the calls' tokens or none.
  {
    name: "invoke_agent support-bot",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "openai",
      "gen_ai.agent.name": "support-bot",
      "gen_ai.usage.input_tokens": 1290,
      "gen_ai.usage.output_tokens": 330,
    },
  },
  {
    name: "execute_tool get_weather",
    attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "get_weather" },
  },
  {
    name: "openai.workflow",
    // An older sender's span with a provider but no tokens.
    attributes: { "gen_ai.system": "openai", "traceloop.span.kind": "workflow" },
  },
  { name: "GET /api/assistant", attributes: { "http.route": "/api/assistant" } },
];

/** The spans, recorded by OpenTelemetry's SDK under one root. */
async function recordSpans(): Promise<ReadableSpan[]> {
  const memory = new InMemorySpanExporter();
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": "assistant",
      "service.version": "1.4.0",
      "deployment.environment.name": "staging",
    }),
    spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
  });
  const tracer = provider.getTracer("ai-calls-test");
  const root = tracer.startSpan("POST /api/assistant", { kind: SpanKind.SERVER });
  const parent = trace.setSpan(context.active(), root);
  for (const item of SPANS) {
    const span = tracer.startSpan(
      item.name,
      { kind: SpanKind.CLIENT, attributes: item.attributes },
      parent,
    );
    span.setStatus({ code: item.failed === true ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    span.end();
  }
  root.end();
  await provider.forceFlush();
  const spans = memory.getFinishedSpans();
  await provider.shutdown();
  return spans;
}

function exported(spans: ReadableSpan[], key: string, protocol: "http/protobuf" | "http/json") {
  const options = { url: `${baseUrl}/v1/traces`, headers: { Authorization: `Bearer ${key}` } };
  const exporter =
    protocol === "http/protobuf" ? new ProtoTraceExporter(options) : new JsonTraceExporter(options);
  return new Promise<{ code: number; error?: Error }>((resolve) => {
    exporter.export(spans, (result) => {
      void exporter.shutdown().then(() => resolve(result));
    });
  });
}

describe.each(["http/protobuf", "http/json"] as const)(
  "OpenTelemetry's %s exporter",
  (protocol) => {
    test("model calls are stored beside their spans, old and new names read; agents, tools, and others are not", async () => {
      const project = await newProject(`AI calls ${protocol}`);
      const spans = await recordSpans();
      const sentAt = Date.now();
      expect((await exported(spans, project.key, protocol)).error).toBeUndefined();

      expect(await storedRows(dashboard.reader.client, "spans", project.id)).toHaveLength(
        SPANS.length + 1,
      );
      const calls = await storedCalls(project.id);
      const byName = new Map(spans.map((span) => [span.spanContext().spanId, span.name] as const));
      expect(calls.map((call) => String(byName.get(String(call.span_id)))).toSorted()).toEqual(
        [
          "chat claude-sonnet-4-6",
          "openai.chat",
          "embeddings text-embedding-3-small",
          "generate_content gemini",
        ].toSorted(),
      );
      const call = (name: string) => calls.find((row) => byName.get(String(row.span_id)) === name);
      const chat = spans.find((span) => span.name === "chat claude-sonnet-4-6");
      // When the request arrived, by the API's clock, as its spans have it.
      const spanRows = await storedRows(dashboard.reader.client, "spans", project.id);
      const arrival = call("chat claude-sonnet-4-6")?.received_at;
      expect(spanRows.map((row) => row.received_at)).toEqual(spanRows.map(() => arrival));
      const arrived = new Date(`${String(arrival).replace(" ", "T")}Z`).getTime();
      expect(arrived).toBeGreaterThanOrEqual(sentAt);
      expect(arrived).toBeLessThanOrEqual(Date.now());
      expect(call("chat claude-sonnet-4-6")).toEqual({
        project_id: project.id,
        timestamp: expect.any(String),
        received_at: arrival,
        id: `${chat?.spanContext().traceId}${chat?.spanContext().spanId}`,
        trace_id: chat?.spanContext().traceId,
        span_id: chat?.spanContext().spanId,
        service: "assistant",
        environment: "staging",
        release: "1.4.0",
        provider: "anthropic",
        // The response's model, before the request's.
        model: "claude-sonnet-4-6-20260601",
        operation: "chat",
        // ottertrail.feature, before the agent's name.
        feature: "support-chat",
        user_id: "user-42",
        // Trimmed, as a feature's name.
        conversation_id: "conv_5Hx9-2026",
        input_tokens: "1200",
        // The GenAI conventions count cached tokens in the input.
        input_includes_cache: true,
        output_tokens: "300",
        output_includes_reasoning: true,
        cache_read_tokens: "800",
        cache_write_tokens: "100",
        reasoning_tokens: "120",
        duration_ns: expect.stringMatching(/^[0-9]+$/),
        first_chunk_ns: "420000000",
        failed: false,
        error_type: "",
        finish_reasons: ["end_turn", "max_tokens"],
      });
      expect(call("openai.chat")).toMatchObject({
        provider: "openai",
        model: "gpt-4o",
        operation: "",
        feature: "support-bot",
        user_id: "user-old",
        conversation_id: "",
        input_tokens: "90",
        output_tokens: "30",
        cache_read_tokens: "0",
        cache_write_tokens: "40",
        first_chunk_ns: null,
        finish_reasons: ["stop"],
      });
      expect(call("embeddings text-embedding-3-small")).toMatchObject({
        operation: "embeddings",
        input_tokens: "12",
        output_tokens: "0",
        feature: "",
        user_id: "",
        conversation_id: "c".repeat(200),
      });
      expect(call("generate_content gemini")).toMatchObject({
        provider: "gcp.gemini",
        model: LONG_MODEL.slice(0, 100),
        input_tokens: "0",
        output_tokens: "0",
        failed: true,
        error_type: `quota_${"x".repeat(194)}`,
        // A feature of only spaces and control characters is none: the agent's name instead.
        feature: "summarizer",
        user_id: "",
        conversation_id: "",
      });
    });

    test("a retried batch is the same rows", async () => {
      const project = await newProject(`AI calls retried ${protocol}`);
      const spans = await recordSpans();
      expect((await exported(spans, project.key, protocol)).error).toBeUndefined();
      expect((await exported(spans, project.key, protocol)).error).toBeUndefined();
      expect(await storedCalls(project.id)).toHaveLength(4);
      await dashboard.reader.client.command({ query: "OPTIMIZE TABLE ai_calls FINAL" });
      expect(await storedCalls(project.id, false)).toHaveLength(4);
    });
  },
);

/** A model call of 1 ms from `start`. */
const chatSpan = (start: bigint) => ({
  traceId: hex(16),
  spanId: hex(8),
  name: "chat gpt-5",
  startTimeUnixNano: String(start),
  endTimeUnixNano: String(start + 1_000_000n),
  attributes: keyValues({ "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 3 }),
});

describe("detection", () => {
  test("a conversation's ID: trimmed, then 1 to 200 characters, counted in code points", () => {
    expect(conversationIdOf("💬".repeat(200))).toBe("💬".repeat(200));
    expect(conversationIdOf("💬".repeat(201))).toBe("");
    expect(conversationIdOf(` ${"c".repeat(199)}  `)).toBe("c".repeat(199));
    expect(conversationIdOf(` ${"c".repeat(201)} `)).toBe("");
    expect(conversationIdOf("conv\u0085")).toBe("");
  });

  test.each([
    ["chat", true],
    ["generate_content", true],
    ["text_completion", true],
    ["realtime_inference", true],
    ["embeddings", true],
    ["invoke_agent", false],
    ["create_agent", false],
    ["invoke_workflow", false],
    ["execute_tool", false],
    ["plan", false],
    ["retrieval", false],
    // An operation the conventions do not list: a provider and tokens make it a call.
    ["summarize", true],
    ["", true],
  ])("operation %s: %s, with a provider and tokens", (operation, counted) => {
    expect(
      isAiCall({
        "gen_ai.operation.name": operation,
        "gen_ai.provider.name": "openai",
        "gen_ai.usage.input_tokens": "10",
      }),
    ).toBe(counted);
  });

  test.each([
    [{ "gen_ai.system": "openai", "gen_ai.usage.prompt_tokens": "1" }, true],
    [{ "gen_ai.provider.name": "anthropic", "gen_ai.usage.output_tokens": "0" }, true],
    [{ "gen_ai.system": "openai", "llm.token_count.completion": "5" }, true],
    [{ "gen_ai.system": "openai" }, false],
    [{ "gen_ai.usage.input_tokens": "10" }, false],
    [{ "gen_ai.system": "openai", "gen_ai.usage.input_tokens": "-1" }, false],
    [{ "gen_ai.system": "openai", "gen_ai.usage.input_tokens": "1.5" }, false],
    [{ "llm.provider": "openai", "llm.token_count.prompt": "5" }, false],
    [{ "gen_ai.operation.name": "summarize", "gen_ai.system": "openai" }, false],
  ])(
    "without an inference operation, a provider and a token count: %o is %s",
    (attributes, counted) => {
      expect(isAiCall(attributes)).toBe(counted);
    },
  );

  test("a span's output holds its reasoning, whatever the provider, as instrumentations count it", () => {
    const now = nowNs();
    const spanOf = (provider: string, model: string) => ({
      traceId: hex(16),
      spanId: hex(8),
      name: "chat",
      startTimeUnixNano: String(now - 2_000_000n),
      endTimeUnixNano: String(now - 1_000_000n),
      attributes: keyValues({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": provider,
        "gen_ai.request.model": model,
        "gen_ai.usage.output_tokens": 200,
        "gen_ai.usage.reasoning.output_tokens": 5000,
      }),
    });
    const { rows } = normalizeTraces(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  spanOf("gcp.gemini", "gemini-2.5-flash"),
                  spanOf("gcp.vertex_ai", "gemini-2.5-pro"),
                  spanOf("openai", "o4-mini"),
                  spanOf("anthropic", "claude-sonnet-4-6"),
                ],
              },
            ],
          },
        ],
      },
      { projectId: "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11", receivedAtNs: now, retentionDays: 30 },
    );
    // OpenLLMetry's Gemini instrumentations and the Vercel AI SDK add the thoughts in.
    expect(aiCallsOf(rows).map((call) => call.output_includes_reasoning)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  test("the feature: ottertrail.feature, else gen_ai.agent.name, else ai.telemetry.functionId", () => {
    const now = nowNs();
    const spanOf = (attributes: Record<string, string | number>) => ({
      traceId: hex(16),
      spanId: hex(8),
      name: "chat",
      startTimeUnixNano: String(now - 2_000_000n),
      endTimeUnixNano: String(now - 1_000_000n),
      attributes: keyValues({
        "gen_ai.system": "anthropic.messages",
        "gen_ai.usage.input_tokens": 30,
        ...attributes,
      }),
    });
    const { rows } = normalizeTraces(
      {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  spanOf({ "ottertrail.feature": "chosen", "ai.telemetry.functionId": "sdk" }),
                  // AI SDK 7's OpenTelemetry integration.
                  spanOf({ "gen_ai.agent.name": "agent", "ai.telemetry.functionId": "sdk" }),
                  // AI SDK 5 and 6, and LegacyOpenTelemetry: the same rules as the others.
                  spanOf({
                    "operation.name": "ai.generateText.doGenerate support",
                    "ai.telemetry.functionId": `  support\u0007-${"x".repeat(200)}  `,
                  }),
                  spanOf({ "ai.telemetry.functionId": "  \u0001 " }),
                  spanOf({}),
                ],
              },
            ],
          },
        ],
      },
      { projectId: "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11", receivedAtNs: now, retentionDays: 30 },
    );
    expect(aiCallsOf(rows).map((call) => call.feature)).toEqual([
      "chosen",
      "agent",
      `support-${"x".repeat(92)}`,
      "",
      "",
    ]);
  });

  test.each([
    ["anthropic", "claude-sonnet-4-6", false],
    ["aws.bedrock", "us.anthropic.claude-sonnet-4-6", false],
    // Converse counts the cache apart for every model; a Responses API call sends true.
    ["aws.bedrock", "openai.gpt-5.5", false],
    ["aws.bedrock", "amazon.nova-pro-v1:0", false],
    ["gcp.vertex_ai", "claude-sonnet-4-6", false],
    ["gcp.vertex_ai", "gemini-2.5-pro", true],
    // OpenAI's SDK on Bedrock's OpenAI-compatible endpoint.
    ["openai", "openai.gpt-5.5", true],
    ["mistral", "mistral-large-4", true],
  ])(
    "an HTTP call from %s %s holds the cache in its input by default: %s",
    (provider, model, includes) => {
      expect(inputIncludesCacheByDefault(provider, model)).toBe(includes);
    },
  );

  test("only the spans a request stores: a refused span makes no call", () => {
    const now = nowNs();
    const { rows, refused } = normalizeTraces(
      { resourceSpans: [{ scopeSpans: [{ spans: [chatSpan(now - 1000n), chatSpan(now * 2n)] }] }] },
      { projectId: "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11", receivedAtNs: now, retentionDays: 30 },
    );
    expect(refused).toBe(1);
    expect(aiCallsOf(rows)).toHaveLength(1);
  });
});

/** A traces request of `calls` model calls and `others` other spans, as protobuf. */
function callsRequest(calls: number, others = 0) {
  const start = nowNs(-5000);
  const span = (attributes: Record<string, string | number>) => ({
    traceId: Buffer.from(hex(16), "hex"),
    spanId: Buffer.from(hex(8), "hex"),
    name: "chat",
    kind: 3,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 1_000_000n),
    attributes: keyValues(attributes),
  });
  return encodeProtobuf(TRACE_MESSAGES, {
    resourceSpans: [
      {
        resource: { attributes: keyValues({ "service.name": "assistant" }) },
        scopeSpans: [
          {
            spans: [
              ...Array.from({ length: calls }, () =>
                span({
                  "gen_ai.operation.name": "chat",
                  "gen_ai.request.model": "gpt-5",
                  "gen_ai.usage.input_tokens": 10,
                }),
              ),
              ...Array.from({ length: others }, () => span({ "http.route": "/" })),
            ],
          },
        ],
      },
    ],
  });
}

function post(app: typeof dashboard.app, key: string, body: Buffer) {
  return app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${key}` },
    payload: body,
  });
}

describe("budgets", () => {
  test("each AI call costs a unit more", async () => {
    const limited = await signedInDashboard({
      telemetry: {
        projectLimit: { capacity: 5, refillPerSecond: 0.01 },
        instanceLimit: { capacity: 1000, refillPerSecond: 1 },
      },
    });
    try {
      const project = await insertProject(limited.db, { name: "AI budget" });
      const key = await secretKeyOf(limited.db, project.id);
      // A batch that costs the whole budget without its AI calls is
      // charged the whole budget with them, never refused as too large:
      // stored while the budget is full, and 429, retried, while it is not.
      const atCapacity = await post(limited.app, key, callsRequest(1, 4));
      expect(atCapacity.statusCode).toBe(200);
      const again = await post(limited.app, key, callsRequest(1, 4));
      expect(again.statusCode).toBe(429);
      expect((await post(limited.app, key, callsRequest(5))).statusCode).toBe(429);
      // Six spans, over the 5 the budget holds with or without calls: 413.
      const project3 = await insertProject(limited.db, { name: "AI budget 3" });
      const key3 = await secretKeyOf(limited.db, project3.id);
      expect((await post(limited.app, key3, callsRequest(1, 5))).statusCode).toBe(413);
      // Another project: a call, 2 of its 5. Then two calls, 4, do not fit
      // in the 3 left (they keep the 1 their decoding cost), where a span
      // that is no call, 1, does.
      const project2 = await insertProject(limited.db, { name: "AI budget 2" });
      const key2 = await secretKeyOf(limited.db, project2.id);
      expect((await post(limited.app, key2, callsRequest(1))).statusCode).toBe(200);
      expect((await post(limited.app, key2, callsRequest(2))).statusCode).toBe(429);
      expect((await post(limited.app, key2, callsRequest(0, 1))).statusCode).toBe(200);
      const rows = await limited.reader.client.query({
        query: "SELECT count() AS n FROM ai_calls FINAL WHERE project_id = {project:UUID}",
        query_params: { project: project2.id },
        format: "JSONEachRow",
      });
      expect(await rows.json()).toEqual([{ n: "1" }]);
    } finally {
      await limited.close();
    }
  });

  test("503 when the AI calls cannot be written, the spans written or not; the budget is given back", async () => {
    // A database without ai_calls: the spans are written, the calls are not.
    const broken = await createTestClickHouse();
    await broken.client.command({ query: "DROP TABLE ai_calls" });
    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: dashboard.clickhouseDatabase },
    );
    const limit = { capacity: 4, refillPerSecond: 0.001 };
    const withoutTable = buildApp({
      db: dashboard.db,
      telemetry: { clickhouse: broken.client, projectLimit: limit },
    });
    const down = buildApp({
      db: dashboard.db,
      telemetry: { clickhouse: unreachable, projectLimit: limit },
    });
    try {
      const project = await newProject("AI calls not written");
      // Two calls: the whole budget, each time, as each 503 gives it back.
      for (const app of [withoutTable, withoutTable, down, down]) {
        const response = await post(app, project.key, callsRequest(2));
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("5");
      }
      // Without the table: the spans of both attempts were written, the calls nowhere.
      // The spans' inserts may still be finishing when the 503 is sent.
      await expect
        .poll(async () => (await storedRows(broken.client, "spans", project.id)).length, {
          timeout: 10_000,
        })
        .toBe(4);
      const tables = await broken.client.query({
        query:
          "SELECT name FROM system.tables WHERE database = {database:String} AND name = 'ai_calls'",
        query_params: { database: broken.database },
        format: "JSONEachRow",
      });
      expect(await tables.json()).toEqual([]);
      // ClickHouse down: nothing in the database the app names.
      expect(await storedRows(dashboard.reader.client, "spans", project.id)).toEqual([]);
      expect(await storedCalls(project.id)).toEqual([]);
    } finally {
      await withoutTable.close();
      await down.close();
      await unreachable.close();
      await broken.destroy();
    }
  });
});
