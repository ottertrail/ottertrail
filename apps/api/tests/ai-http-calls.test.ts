import { randomBytes, randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { IngestActivity } from "../src/activity/activity.ts";
import { aiCallIngestRoutes, MAX_AI_CALLS_PER_BATCH } from "../src/ai/ingest-routes.ts";
import { evaluateTelemetryRule, telemetryRules } from "../src/alerts/telemetry-rules.ts";
import { buildApp } from "../src/app.ts";
import { type ClickHouseClient, createClickHouse } from "../src/clickhouse/clickhouse.ts";
import type { ProjectKeyCache } from "../src/collection/project-keys.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { SecretKeyLookups } from "../src/telemetry/key-lookups.ts";
import { telemetryBudget } from "../src/telemetry/routes.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { hangingUpClient } from "./helpers/hang-up.ts";
import { insertProject } from "./helpers/projects.ts";
import { secretKeyOf } from "./helpers/telemetry.ts";

/**
 * POST /api/ai-calls (docs/ai-usage.md, "Sending calls over HTTP";
 * ai/ingest-routes.ts): AI calls an app's server sends without
 * OpenTelemetry, into ai_calls. The secret key, the schema and its limits,
 * the server's clock, a retried batch one row, each call a unit of the
 * telemetry budget OTLP shares, 503 while ClickHouse cannot write, and the
 * calls on the AI page and in an alert rule.
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let secretKey = "";
let publicKey = "";

beforeAll(async () => {
  dashboard = await signedInDashboard();
  const project = await insertProject(dashboard.db, { name: "AI over HTTP" });
  projectId = project.id;
  publicKey = project.public_key;
  secretKey = await secretKeyOf(dashboard.db, projectId);
});

afterAll(async () => {
  await dashboard?.close();
});

/** The header that sends a secret key. */
function bearer(key: string) {
  return { authorization: `Bearer ${key}` };
}

/** A well-formed secret key no project has. */
function unknownKey(n: number): string {
  return `sk_${n.toString(16).padStart(32, "0")}`;
}

function aiCall(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    occurredAt: Date.now() - 60_000,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    operation: "chat",
    inputTokens: 1200,
    outputTokens: 300,
    durationMs: 1850.5,
    ...overrides,
  };
}

function send(
  body: unknown,
  headers: Record<string, string> = {},
  app: ReturnType<typeof buildApp> = dashboard.app,
  remoteAddress?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/ai-calls",
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secretKey}`,
      ...headers,
    },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A project's ai_calls rows, one per ID (FINAL) or every copy, oldest first. */
async function storedCalls(id: string, final = true): Promise<Record<string, unknown>[]> {
  const result = await dashboard.reader.client.query({
    query: `SELECT * FROM ai_calls ${final ? "FINAL" : ""} WHERE project_id = {project:UUID}
            ORDER BY timestamp, id`,
    query_params: { project: id },
    format: "JSONEachRow",
  });
  return result.json();
}

async function newProject(name: string) {
  const project = await insertProject(dashboard.db, { name });
  return { id: project.id, key: await secretKeyOf(dashboard.db, project.id) };
}

describe("POST /api/ai-calls", () => {
  test("stores calls in ai_calls, as spans' calls are, with the batch's environment and release", async () => {
    const project = await newProject("Stored");
    const sentAt = Date.now();
    const at = Date.now() - 5000;
    const traceId = randomBytes(16).toString("hex").toUpperCase();
    const full = aiCall({
      occurredAt: at,
      cacheReadTokens: 800,
      cacheWriteTokens: 40,
      reasoningTokens: 12,
      firstChunkMs: 420,
      finishReasons: ["End_Turn"],
      userId: "user-42",
      feature: "  support-chat ",
      conversationId: " conv_5Hx9-2026  ",
      service: "billing-api",
      traceId,
      spanId: "00f067aa0ba902b7",
    });
    const failed = aiCall({ model: "gpt-5-mini", provider: "openai", errorType: "RateLimitError" });
    const failedWithoutType = aiCall({ ok: false, operation: undefined });
    const response = await send(
      {
        v: 1,
        environment: "Staging",
        release: "api@2.3.0",
        calls: [full, failed, failedWithoutType],
      },
      { authorization: `Bearer ${project.key}` },
    );
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ stored: 3, tooOld: 0 });

    const rows = await storedCalls(project.id);
    const byId = new Map(rows.map((row) => [row.id, row]));
    // When the request arrived, by the API's clock, not when the call happened.
    const arrived = new Date(`${String(byId.get(full.id)?.received_at).replace(" ", "T")}Z`);
    expect(arrived.getTime()).toBeGreaterThanOrEqual(sentAt);
    expect(arrived.getTime()).toBeLessThanOrEqual(Date.now());
    expect(byId.get(full.id)).toEqual({
      project_id: project.id,
      timestamp: new Date(at).toISOString().replace("T", " ").replace("Z", "000000"),
      received_at: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/),
      id: full.id,
      trace_id: traceId.toLowerCase(),
      span_id: "00f067aa0ba902b7",
      service: "billing-api",
      environment: "staging",
      release: "api@2.3.0",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      operation: "chat",
      feature: "support-chat",
      user_id: "user-42",
      conversation_id: "conv_5Hx9-2026",
      input_tokens: "1200",
      // Anthropic's API counts cached tokens apart from the input.
      input_includes_cache: false,
      output_tokens: "300",
      output_includes_reasoning: true,
      cache_read_tokens: "800",
      cache_write_tokens: "40",
      reasoning_tokens: "12",
      duration_ns: "1850500000",
      first_chunk_ns: "420000000",
      failed: false,
      error_type: "",
      finish_reasons: ["end_turn"],
    });
    expect(byId.get(failed.id)).toMatchObject({
      received_at: byId.get(full.id)?.received_at,
      input_includes_cache: true,
      failed: true,
      error_type: "RateLimitError",
      trace_id: "",
      span_id: "",
      service: "",
      feature: "",
      user_id: "",
      conversation_id: "",
      cache_read_tokens: "0",
      first_chunk_ns: null,
      finish_reasons: [],
    });
    expect(byId.get(failedWithoutType.id)).toMatchObject({
      failed: true,
      error_type: "",
      operation: "",
    });
  });

  test("an empty operation, error type, or finish reason, or a blank feature, conversation, or service, is as left out", async () => {
    const project = await newProject("Empty");
    const call = aiCall({
      operation: "",
      feature: "   ",
      conversationId: "  ",
      service: "",
      errorType: "",
      finishReasons: ["", "stop"],
    });
    const response = await send(
      { v: 1, calls: [call] },
      { authorization: `Bearer ${project.key}` },
    );
    expect(response.statusCode).toBe(202);
    expect(await storedCalls(project.id)).toMatchObject([
      {
        operation: "",
        feature: "",
        conversation_id: "",
        service: "",
        error_type: "",
        failed: false,
        finish_reasons: ["stop"],
      },
    ]);
  });

  test("a conversation ID's length is counted in characters once trimmed, as a span's", async () => {
    const project = await newProject("Conversation lengths");
    const authorization = `Bearer ${project.key}`;
    // 200 emoji are 400 UTF-16 units, 200 characters; 199 and two spaces are 199 once trimmed.
    const emoji = aiCall({ conversationId: "💬".repeat(200) });
    const padded = aiCall({ conversationId: ` ${"c".repeat(199)} ` });
    expect((await send({ v: 1, calls: [emoji, padded] }, { authorization })).statusCode).toBe(202);
    const rows = new Map((await storedCalls(project.id)).map((row) => [row.id, row]));
    expect(rows.get(emoji.id)?.conversation_id).toBe("💬".repeat(200));
    expect(rows.get(padded.id)?.conversation_id).toBe("c".repeat(199));
    const over = await send(
      { v: 1, calls: [aiCall({ conversationId: "💬".repeat(201) })] },
      { authorization },
    );
    expect(over.statusCode).toBe(400);
  });

  test("a retried batch is the same rows: its id and time are the key", async () => {
    const project = await newProject("Retries");
    const calls = [aiCall(), aiCall()];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await send({ v: 1, calls }, { authorization: `Bearer ${project.key}` });
      expect(response.json()).toEqual({ stored: 2, tooOld: 0 });
    }
    expect(await storedCalls(project.id)).toHaveLength(2);
    // Merged, every copy is gone.
    await dashboard.reader.client.command({ query: "OPTIMIZE TABLE ai_calls FINAL" });
    expect(await storedCalls(project.id, false)).toHaveLength(2);
  });

  test("a retry with a corrected time on the same day is the same row: the key holds the day", async () => {
    const project = await newProject("Retries, corrected time");
    // Noon UTC today, or just before now when it is earlier, then 3 seconds later.
    const noon = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`).getTime();
    const at = Math.min(noon, Date.now() - 10_000);
    const call = aiCall({ occurredAt: at });
    const authorization = `Bearer ${project.key}`;
    expect((await send({ v: 1, calls: [call] }, { authorization })).statusCode).toBe(202);
    const retry = { ...call, occurredAt: at + 3000 };
    expect((await send({ v: 1, calls: [retry] }, { authorization })).statusCode).toBe(202);
    const rows = await storedCalls(project.id);
    expect(rows).toHaveLength(1);
    // The copy written last is the one kept.
    expect(rows[0]?.timestamp).toBe(
      new Date(at + 3000).toISOString().replace("T", " ").replace("Z", "000000"),
    );
  });

  test("whether the output holds the reasoning tokens: as sent, else by the provider", async () => {
    const project = await newProject("Reasoning output");
    const thinking = { outputTokens: 200, reasoningTokens: 5000 };
    const cases = [
      [aiCall({ ...thinking, provider: "openai", model: "o4-mini" }), true],
      [aiCall({ ...thinking, provider: "anthropic" }), true],
      [aiCall({ ...thinking, provider: "gcp.gemini", model: "gemini-2.5-flash" }), false],
      [aiCall({ ...thinking, provider: "gcp.vertex_ai", model: "gemini-2.5-pro" }), false],
      [aiCall({ ...thinking, provider: "gcp.vertex_ai", model: "claude-sonnet-4-6" }), true],
      [aiCall({ ...thinking, provider: "openai", outputIncludesReasoning: false }), false],
      [
        aiCall({
          ...thinking,
          provider: "gcp.gemini",
          model: "gemini-2.5-flash",
          outputIncludesReasoning: true,
        }),
        true,
      ],
    ] as const;
    const response = await send(
      { v: 1, calls: cases.map(([call]) => call) },
      { authorization: `Bearer ${project.key}` },
    );
    expect(response.statusCode).toBe(202);
    const rows = new Map((await storedCalls(project.id)).map((row) => [row.id, row]));
    expect(cases.map(([call]) => rows.get(call.id)?.output_includes_reasoning)).toEqual(
      cases.map(([, includes]) => includes),
    );
  });

  test("whether the input holds the cached tokens: as sent, else by the provider", async () => {
    const project = await newProject("Cached input");
    const cached = { inputTokens: 1000, cacheReadTokens: 500 };
    const cases = [
      [aiCall({ ...cached, provider: "anthropic" }), false],
      [aiCall({ ...cached, provider: "openai", model: "gpt-5-mini" }), true],
      [
        aiCall({ ...cached, provider: "aws.bedrock", model: "us.anthropic.claude-sonnet-4-6" }),
        false,
      ],
      [aiCall({ ...cached, provider: "aws.bedrock", model: "openai.gpt-5.5" }), true],
      [aiCall({ ...cached, provider: "gcp.vertex_ai", model: "claude-sonnet-4-6" }), false],
      [aiCall({ ...cached, provider: "gcp.vertex_ai", model: "gemini-2.5-pro" }), true],
      [aiCall({ ...cached, provider: "anthropic", inputIncludesCache: true }), true],
      [aiCall({ ...cached, provider: "openai", inputIncludesCache: false }), false],
      // Less input than cached cannot hold it, whatever the sender says.
      [
        aiCall({
          inputTokens: 10,
          cacheReadTokens: 20,
          provider: "openai",
          inputIncludesCache: true,
        }),
        false,
      ],
    ] as const;
    const response = await send(
      { v: 1, calls: cases.map(([call]) => call) },
      { authorization: `Bearer ${project.key}` },
    );
    expect(response.statusCode).toBe(202);
    const rows = new Map((await storedCalls(project.id)).map((row) => [row.id, row]));
    expect(cases.map(([call]) => rows.get(call.id)?.input_includes_cache)).toEqual(
      cases.map(([, includes]) => includes),
    );
  });

  test("needs the project's secret key, checked before the body is read", async () => {
    for (const authorization of [
      undefined,
      "Bearer pk_00000000000000000000000000000000",
      `Bearer ${publicKey}`,
      "sk_x",
      `Basic ${secretKey}`,
    ]) {
      const response = await dashboard.app.inject({
        method: "POST",
        url: "/api/ai-calls",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        // Not even valid JSON: the key is checked first.
        payload: "{",
      });
      expect({ authorization, status: response.statusCode }).toEqual({
        authorization,
        status: 401,
      });
      expect(response.json().error).toBe("unauthorized");
    }
    // The public key's hex with the secret prefix: well formed, unknown.
    const call = aiCall();
    const withPublic = await send(
      { v: 1, calls: [call] },
      { authorization: `Bearer ${publicKey.replace("pk_", "sk_")}` },
    );
    expect(withPublic.statusCode).toBe(401);
    expect(withPublic.json().error).toBe("unknown_key");
    expect((await storedCalls(projectId)).map((row) => row.id)).not.toContain(call.id);
  });

  test.each([
    [{ id: "call-1" }, "an id that is not a UUID"],
    [{ provider: undefined }, "no provider"],
    [{ model: "" }, "an empty model"],
    [{ model: "   " }, "a blank model"],
    [{ model: "m".repeat(101) }, "a model over 100 characters"],
    [{ model: "claude\u0000" }, "a control character"],
    [{ model: "claude\ud800" }, "an unpaired surrogate"],
    [{ durationMs: undefined }, "no duration"],
    [{ durationMs: -1 }, "a negative duration"],
    [{ durationMs: 86_400_001 }, "a duration over a day"],
    [{ inputTokens: -1 }, "a negative token count"],
    [{ outputTokens: 1.5 }, "a fractional token count"],
    [{ inputTokens: 10_000_001 }, "a token count over 10^7"],
    [{ durationMs: 1000, firstChunkMs: 1000.5 }, "a first chunk after the call ended"],
    [{ occurredAt: Date.now() + 10 * 60_000 }, "a time ten minutes ahead"],
    [{ occurredAt: new Date().toISOString() }, "a time as text"],
    [{ ok: true, errorType: "RateLimitError" }, "ok with an error type"],
    [{ errorType: "E".repeat(101) }, "an error type over 100 characters"],
    [{ userId: "" }, "an empty user ID"],
    [{ userId: "u".repeat(201) }, "a user ID over 200 characters"],
    [{ feature: "f".repeat(101) }, "a feature over 100 characters"],
    [{ conversationId: "c".repeat(201) }, "a conversation ID over 200 characters"],
    [{ conversationId: "conv\u0007" }, "a conversation ID with a control character"],
    [{ conversationId: "conv\ud800" }, "a conversation ID with an unpaired surrogate"],
    [{ traceId: "xyz" }, "a trace ID that is not 32 hex characters"],
    [{ spanId: "00f067aa0ba902b7" }, "a span ID without its trace ID"],
    [{ finishReasons: Array.from({ length: 17 }, () => "stop") }, "17 finish reasons"],
    [{ finishReasons: ["s".repeat(33)] }, "a finish reason over 32 characters"],
    [{ finishReasons: ["end turn"] }, "a finish reason with a space"],
    [{ provider: "open ai" }, "a provider with a space"],
    [{ model: "gpt-4o\u200b" }, "a model with a zero-width space"],
    [{ model: "gpt\ue000" }, "a model with a private-use character"],
    [{ operation: "chat\u2028" }, "an operation with a line separator"],
    [{ errorType: "Rate\tlimit" }, "an error type with a tab"],
    [{ errorType: "Rate\u2028limit" }, "an error type with a line separator"],
    [{ errorType: "E\u202e" }, "an error type with a bidi override"],
    [{ feature: "support\u202echat" }, "a feature with a bidi override"],
    [{ feature: "a\u2029b" }, "a feature with a paragraph separator"],
    [{ userId: "user\u200d42" }, "a user ID with a zero-width joiner"],
    [{ userId: "user\u2028" }, "a user ID with a line separator"],
    [{ conversationId: "conv\ufeff" }, "a conversation ID with a byte order mark"],
    [{ ok: null }, "ok as null, which coercion would make false"],
    [{ inputTokens: "5" }, "a token count as text"],
    [{ inputTokens: null }, "a token count as null"],
    [{ provider: 5 }, "a provider as a number"],
    [{ finishReasons: "stop" }, "finish reasons not in a list"],
  ] as [Record<string, unknown>, string][])(
    "refuses %j (%s), the whole batch",
    async (overrides) => {
      const good = aiCall();
      const bad = aiCall(overrides);
      const response = await send({ v: 1, calls: [good, bad] });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_request");
      const ids = (await storedCalls(projectId)).map((row) => row.id);
      expect(ids).not.toContain(good.id);
      expect(ids).not.toContain(bad.id);
    },
  );

  test("takes what real calls send: thought tokens over output, many choices, error names with spaces", async () => {
    const project = await newProject("Real calls");
    // Gemini counts thoughts apart from the answer (thoughtsTokenCount, candidatesTokenCount).
    const gemini = aiCall({
      provider: "gcp.gemini",
      model: "gemini-2.5-flash",
      outputTokens: 12,
      reasoningTokens: 900,
    });
    const choices = aiCall({ finishReasons: Array.from({ length: 16 }, () => "stop") });
    const failed = aiCall({ errorType: "Too Many Requests" });
    const untidy = aiCall({ errorType: " Rate   limit  " });
    const response = await send(
      { v: 1, calls: [gemini, choices, failed, untidy] },
      { authorization: `Bearer ${project.key}` },
    );
    expect(response.statusCode).toBe(202);
    const rows = new Map((await storedCalls(project.id)).map((row) => [row.id, row]));
    expect(rows.get(gemini.id)).toMatchObject({
      output_tokens: "12",
      reasoning_tokens: "900",
      // Gemini's API counts thoughts apart from the output.
      output_includes_reasoning: false,
    });
    expect(rows.get(choices.id)?.finish_reasons).toHaveLength(16);
    expect(rows.get(failed.id)).toMatchObject({ failed: true, error_type: "Too Many Requests" });
    expect(rows.get(untidy.id)?.error_type).toBe("Rate limit");
  });

  test("takes JSON types as sent: null is never false, nor text a number", async () => {
    expect((await send([aiCall()])).json().message).toBe("The body must be an object.");
    const response = await send({ v: 1, calls: [aiCall(), aiCall({ ok: null })] });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("calls[1].ok must be true or false.");
    const tokens = await send({ v: 1, calls: [aiCall({ outputTokens: "300" })] });
    expect(tokens.json().message).toBe("calls[0].outputTokens must be a whole number.");
  });

  test.each([
    [{ v: 2, calls: [aiCall()] }, "another version"],
    [{ v: 1, calls: [] }, "no calls"],
    [{ v: 1 }, "no list"],
    [{ v: 1, environment: "pro duction", calls: [aiCall()] }, "an environment with a space"],
    [{ v: 1, release: "a b", calls: [aiCall()] }, "a release with a space"],
  ] as [Record<string, unknown>, string][])("refuses a batch with %j (%s)", async (body) => {
    expect((await send(body)).statusCode).toBe(400);
  });

  test("never stores a prompt or a completion: fields it does not know are dropped", async () => {
    const project = await newProject("Content");
    const call = aiCall({
      prompt: "What is my account's password?",
      completion: "It is hunter2.",
      messages: [{ role: "user", content: "secret" }],
    });
    const response = await send(
      { v: 1, input: "secret", calls: [call] },
      { authorization: `Bearer ${project.key}` },
    );
    expect(response.statusCode).toBe(202);
    const [row] = await storedCalls(project.id);
    expect(JSON.stringify(row)).not.toMatch(/password|hunter2|secret/);
  });

  test("at most 1,000 calls in a batch, and a body of at most 1 MiB", async () => {
    const project = await newProject("Limits");
    const authorization = `Bearer ${project.key}`;
    const calls = Array.from({ length: MAX_AI_CALLS_PER_BATCH }, () => aiCall());
    const full = await send({ v: 1, calls }, { authorization });
    expect(full.json()).toEqual({ stored: 1000, tooOld: 0 });
    const over = await send({ v: 1, calls: [...calls, aiCall()] }, { authorization });
    expect(over.statusCode).toBe(400);

    // Three bytes a character: about 2 KB a call.
    const large = Array.from({ length: 1000 }, () =>
      aiCall({ userId: "€".repeat(200), errorType: "€".repeat(200), feature: "€".repeat(100) }),
    );
    const tooLarge = await send({ v: 1, calls: large }, { authorization });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error).toBe("payload_too_large");
    expect(await storedCalls(project.id)).toHaveLength(1000);

    const asXml = await send("<calls/>", { authorization, "content-type": "application/xml" });
    expect(asXml.statusCode).toBe(415);
    expect(asXml.json().error).toBe("unsupported_media_type");
  });

  test("counts a call over a day old instead of storing it", async () => {
    const project = await newProject("Too old");
    const old = aiCall({ occurredAt: Date.now() - 25 * 60 * 60 * 1000 });
    const response = await send(
      { v: 1, calls: [old, aiCall()] },
      { authorization: `Bearer ${project.key}` },
    );
    expect(response.json()).toEqual({ stored: 1, tooOld: 1 });
    expect(await storedCalls(project.id)).toHaveLength(1);
  });

  test("never lets a page read the answer: a page must not hold the secret key", async () => {
    const response = await send({ v: 1, calls: [aiCall()] }, { origin: "https://example.com" });
    expect(response.statusCode).toBe(202);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("limits", () => {
  test("each call is a unit of the telemetry budget, which OTLP shares; the address's rate", async () => {
    const limited = await signedInDashboard({
      telemetry: {
        projectLimit: { capacity: 5, refillPerSecond: 0.01 },
        instanceLimit: { capacity: 1000, refillPerSecond: 1 },
      },
    });
    try {
      const project = await insertProject(limited.db, { name: "Budget" });
      const authorization = `Bearer ${await secretKeyOf(limited.db, project.id)}`;
      // More than the whole budget: never allowed, 413.
      const six = Array.from({ length: 6 }, () => aiCall());
      const tooMany = await send({ v: 1, calls: six }, { authorization }, limited.app);
      expect(tooMany.statusCode).toBe(413);
      const four = await send({ v: 1, calls: six.slice(0, 4) }, { authorization }, limited.app);
      expect(four.statusCode).toBe(202);
      const two = await send({ v: 1, calls: six.slice(4) }, { authorization }, limited.app);
      expect(two.statusCode).toBe(429);
      expect(two.json().error).toBe("rate_limited");
      expect(Number(two.headers["retry-after"])).toBeGreaterThan(0);
      // The one unit left: a span over OTLP takes it, then nothing is left for a call.
      const span = await limited.app.inject({
        method: "POST",
        url: "/v1/traces",
        headers: { "content-type": "application/json", authorization },
        payload: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: randomBytes(16).toString("hex"),
                      spanId: randomBytes(8).toString("hex"),
                      name: "GET /",
                      kind: 2,
                      startTimeUnixNano: String(BigInt(Date.now() - 1000) * 1_000_000n),
                      endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      expect(span.statusCode).toBe(200);
      const one = await send({ v: 1, calls: [aiCall()] }, { authorization }, limited.app);
      expect(one.statusCode).toBe(429);
      const rows = await limited.reader.client.query({
        query: "SELECT count() AS n FROM ai_calls FINAL WHERE project_id = {project:UUID}",
        query_params: { project: project.id },
        format: "JSONEachRow",
      });
      expect(await rows.json()).toEqual([{ n: "4" }]);
    } finally {
      await limited.close();
    }

    const app = buildApp({
      db: dashboard.db,
      telemetry: { clickhouse: dashboard.reader.client },
      aiCalls: { ipLimit: { capacity: 2, refillPerSecond: 0.001 } },
    });
    try {
      // Counted before the key or the body: a made-up key spends the address's rate too.
      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await send(
          { v: 1, calls: [aiCall()] },
          { authorization: `Bearer sk_${"0".repeat(32)}` },
          app,
        );
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([401, 401, 429]);
      // An IPv6 address counts by its /64: another address in it shares the bucket.
      const unknown = { authorization: `Bearer sk_${"0".repeat(32)}` };
      const body = { v: 1, calls: [aiCall()] };
      expect((await send(body, unknown, app, "2001:db8:1:2::1")).statusCode).toBe(401);
      expect((await send(body, unknown, app, "2001:db8:1:2::2")).statusCode).toBe(401);
      expect((await send(body, unknown, app, "2001:db8:1:2:ffff::9")).statusCode).toBe(429);
      expect((await send(body, unknown, app, "2001:db8:1:3::1")).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  test("requests in progress: at most the instance's, and of those one project's, as OTLP's", async () => {
    // A ClickHouse whose inserts wait until the test lets them finish.
    const waiting: (() => void)[] = [];
    const slow = {
      insert: () =>
        new Promise<void>((resolve) => {
          waiting.push(resolve);
        }),
    } as unknown as ClickHouseClient;
    const app = buildApp({
      db: dashboard.db,
      telemetry: { clickhouse: slow },
      aiCalls: { maxInFlight: 2, maxInFlightPerProject: 1 },
    });
    try {
      const first = await newProject("In progress 1");
      const second = await newProject("In progress 2");
      const firstAuth = { authorization: `Bearer ${first.key}` };
      const secondAuth = { authorization: `Bearer ${second.key}` };
      const body = { v: 1, calls: [aiCall()] };
      const one = send(body, firstAuth, app);
      await expect.poll(() => waiting.length).toBe(1);
      const sameProject = await send(body, firstAuth, app);
      expect(sameProject.statusCode).toBe(429);
      expect(sameProject.headers["retry-after"]).toBe("1");
      const two = send(body, secondAuth, app);
      await expect.poll(() => waiting.length).toBe(2);
      const full = await send(body, secondAuth, app);
      expect(full.statusCode).toBe(503);
      expect(full.json().error).toBe("busy");
      for (const resolve of waiting) resolve();
      expect((await one).statusCode).toBe(202);
      expect((await two).statusCode).toBe(202);
      // Their places are given back.
      const after = send(body, firstAuth, app);
      await expect.poll(() => waiting.length).toBe(3);
      waiting[2]?.();
      expect((await after).statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });

  test("a key is looked up before it takes a slot: made-up keys being looked up hold none", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let lookups = 0;
    const real = `sk_${"a".repeat(32)}`;
    // Any other key's lookup waits for the gate, as a cache miss waits for the database.
    const projects = {
      peekSecret: () => undefined,
      findBySecret: async (key: string) => {
        lookups += 1;
        if (key === real) return { id: "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11" };
        await gate;
        return null;
      },
    } as unknown as ProjectKeyCache;
    const app = Fastify();
    await app.register(aiCallIngestRoutes, {
      prefix: "/api",
      clickhouse: { insert: async () => {} } as unknown as ClickHouseClient,
      projects,
      activity: { add: () => {} } as unknown as IngestActivity,
      budget: telemetryBudget({}),
      maxInFlight: 1,
    });
    try {
      const body = { v: 1, calls: [aiCall()] };
      const madeUp = send(
        body,
        { authorization: `Bearer sk_${"b".repeat(32)}` },
        app,
        "198.51.100.1",
      );
      await expect.poll(() => lookups).toBe(1);
      expect((await send(body, { authorization: `Bearer ${real}` }, app)).statusCode).toBe(202);
      open();
      expect((await madeUp).statusCode).toBe(401);
    } finally {
      open();
      await app.close();
    }
  });

  test("503 busy while the places for lookups of unknown keys are taken", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let lookups = 0;
    const real = `sk_${"a".repeat(32)}`;
    const fresh = `sk_${"c".repeat(32)}`;
    // Made-up keys' lookups wait for the gate, as a cache miss waits for the database.
    const projects = {
      peekSecret: () => undefined,
      findBySecret: async (key: string) => {
        lookups += 1;
        if (key === real) return { id: "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11" };
        if (key === fresh) return { id: "7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e" };
        await gate;
        return null;
      },
    } as unknown as ProjectKeyCache;
    const app = Fastify();
    await app.register(aiCallIngestRoutes, {
      prefix: "/api",
      clickhouse: { insert: async () => {} } as unknown as ClickHouseClient,
      projects,
      activity: { add: () => {} } as unknown as IngestActivity,
      budget: telemetryBudget({}),
      keyLookups: new SecretKeyLookups({ max: 1, maxWaiting: 0 }),
    });
    try {
      const body = { v: 1, calls: [aiCall()] };
      const waiting = send(body, bearer(unknownKey(1)), app, "198.51.100.1");
      await expect.poll(() => lookups).toBe(1);
      const full = await send(body, bearer(unknownKey(2)), app, "198.51.100.2");
      expect([full.statusCode, full.json().error]).toEqual([503, "busy"]);
      open();
      expect((await waiting).statusCode).toBe(401);
      expect((await send(body, bearer(fresh), app, "198.51.100.2")).statusCode).toBe(202);
    } finally {
      open();
      await app.close();
    }
  });
  test("a client that hangs up while its calls are being written holds its slots until the insert settles", async () => {
    // A ClickHouse that holds each insert while `hold` is on, until the test lets it finish.
    let hold = true;
    let heldNow = 0;
    let heldMost = 0;
    const waiting: (() => void)[] = [];
    const slow = {
      insert: async () => {
        if (!hold) return;
        heldNow += 1;
        heldMost = Math.max(heldMost, heldNow);
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
        heldNow -= 1;
      },
    } as unknown as ClickHouseClient;
    const app = buildApp({
      db: dashboard.db,
      telemetry: { clickhouse: slow },
      aiCalls: { maxInFlight: 2, maxInFlightPerProject: 1 },
    });
    try {
      const project = await newProject("Hangs up");
      const auth = { authorization: `Bearer ${project.key}` };
      const hangUp = await hangingUpClient(app);
      const body = () => ({ v: 1, calls: [aiCall()] });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        hold = true;
        const before = waiting.length;
        await hangUp(
          "/api/ai-calls",
          { "content-type": "application/json", ...auth },
          JSON.stringify(body()),
          () => waiting.length > before,
        );
        // Its insert is still held, so its slot is too: a retry waits.
        expect((await send(body(), auth, app)).statusCode).toBe(429);
        // Once the insert settles, the slot is given back.
        hold = false;
        waiting.shift()?.();
        await expect.poll(async () => (await send(body(), auth, app)).statusCode).toBe(202);
      }
      // Never more work in progress than the project's limit.
      expect(heldMost).toBe(1);
    } finally {
      for (const resolve of waiting) resolve();
      await app.close();
    }
  });

  test("the key is looked up before the body is read: an unknown key's body is never parsed", async () => {
    // Over 1 MiB, and not JSON: read, it would be 413 or 400.
    const junk = `{${"x".repeat(2 * 1024 * 1024)}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await send(junk, { authorization: `Bearer sk_${"1".repeat(32)}` });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("unknown_key");
    }
  });

  test("503 if the key cannot be looked up, whatever the body", async () => {
    const unreachable = createDatabase({
      connectionString: "postgres://unused@127.0.0.1:1/unused",
    });
    const broken = buildApp({
      db: unreachable,
      telemetry: { clickhouse: dashboard.reader.client },
    });
    try {
      const bad = await send({ v: 1, calls: [aiCall({ model: "" })] }, {}, broken);
      expect(bad.statusCode).toBe(503);
      const good = await send({ v: 1, calls: [aiCall()] }, {}, broken);
      expect(good.statusCode).toBe(503);
      expect(good.headers["retry-after"]).toBe("5");
      expect(good.json()).toMatchObject({ error: "storage_unavailable" });
    } finally {
      await broken.close();
      await unreachable.destroy();
    }
  });

  test("503, for a retry, and nothing stored, while ClickHouse cannot write; the budget is given back", async () => {
    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: dashboard.clickhouseDatabase },
    );
    const down = buildApp({
      db: dashboard.db,
      telemetry: { clickhouse: unreachable, projectLimit: { capacity: 2, refillPerSecond: 0.001 } },
    });
    try {
      const project = await newProject("ClickHouse down");
      const calls = [aiCall(), aiCall()];
      // The whole budget each time: each 503 gives it back.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await send(
          { v: 1, calls },
          { authorization: `Bearer ${project.key}` },
          down,
        );
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("5");
        expect(response.json()).toMatchObject({ error: "storage_unavailable" });
      }
      expect(await storedCalls(project.id)).toEqual([]);
    } finally {
      await down.close();
      await unreachable.close();
    }
  });
});

describe("read as spans' calls are", () => {
  test("the AI page's figures, users, and latest calls; an alert rule's cost", async () => {
    const project = await newProject("Read");
    const authorization = `Bearer ${project.key}`;
    const at = Date.now() - 2 * 60 * 60_000;
    const response = await send(
      {
        v: 1,
        calls: [
          aiCall({ occurredAt: at, feature: "support-chat", userId: "ada" }),
          aiCall({ occurredAt: at + 1000, errorType: "APITimeoutError", feature: "support-chat" }),
        ],
      },
      { authorization },
    );
    expect(response.statusCode).toBe(202);

    const get = async (path: string) => {
      const reply = await dashboard.app.inject({
        url: `/api/projects/${project.id}${path}`,
        headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
      });
      expect({ path, status: reply.statusCode }).toEqual({ path, status: 200 });
      return reply.json();
    };
    const report = await get("/ai?period=7d");
    expect(report).toMatchObject({
      received: true,
      environment: "production",
      totals: { calls: 2, inputTokens: 2400, outputTokens: 600, failed: 1, noPriceCalls: 0 },
    });
    expect(report.totals.costUsd).toBeGreaterThan(0);
    expect(
      report.features.map((row: { feature: string; calls: number }) => [row.feature, row.calls]),
    ).toEqual([["support-chat", 2]]);
    expect(report.users).toEqual([expect.objectContaining({ userId: "ada", calls: 1 })]);

    const { calls } = await get("/ai/calls?period=7d");
    expect(calls).toMatchObject([
      { traceId: "", spanId: "", failed: true, errorType: "APITimeoutError" },
      { traceId: "", spanId: "", userId: "ada", feature: "support-chat", failed: false },
    ]);

    const channel = await dashboard.db
      .insertInto("notification_channels")
      .values({
        name: "AI over HTTP",
        kind: "webhook",
        webhook_url: "https://hooks.example.com/ai",
        webhook_secret: "x".repeat(43),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const evaluatedAt = new Date(at + 30 * 60_000);
    const rule = await dashboard.db
      .insertInto("alert_rules")
      .values({
        project_id: project.id,
        name: "AI cost",
        kind: "ai_cost",
        settings: JSON.stringify({
          environment: "production",
          feature: "support-chat",
          model: null,
          costWindow: "1h",
          thresholdUsd: 0.000_001,
        }),
        channel_ids: [channel.id],
        active_since: new Date(at - 60 * 60_000),
        created_at: new Date(at - 60 * 60_000),
        updated_at: new Date(at - 60 * 60_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const rules = await telemetryRules(dashboard.db, project.id);
    const loaded = rules.find((item) => item.id === rule.id);
    if (loaded === undefined) throw new Error("no such rule");
    const outcome = await evaluateTelemetryRule(
      { db: dashboard.db, publicUrl: PUBLIC_URL },
      dashboard.reader,
      loaded,
      evaluatedAt,
    );
    expect(outcome).toMatchObject({
      outcome: "sent",
      reading: { value: expect.closeTo(report.totals.costUsd, 9), calls: 2 },
    });
  });
});
