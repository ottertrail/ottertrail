import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { MAX_AI_CALLS_PER_BATCH } from "../src/ai/ingest-routes.ts";
import { evaluateTelemetryRule, telemetryRules } from "../src/alerts/telemetry-rules.ts";
import { buildApp } from "../src/app.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
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
) {
  return app.inject({
    method: "POST",
    url: "/api/ai-calls",
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
    expect(byId.get(full.id)).toEqual({
      project_id: project.id,
      timestamp: new Date(at).toISOString().replace("T", " ").replace("Z", "000000"),
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
      input_tokens: "1200",
      output_tokens: "300",
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
      failed: true,
      error_type: "RateLimitError",
      trace_id: "",
      span_id: "",
      service: "",
      feature: "",
      user_id: "",
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
    [{ inputTokens: 1_000_000_001 }, "a token count over 10^9"],
    [{ occurredAt: Date.now() + 10 * 60_000 }, "a time ten minutes ahead"],
    [{ occurredAt: new Date().toISOString() }, "a time as text"],
    [{ ok: true, errorType: "RateLimitError" }, "ok with an error type"],
    [{ errorType: "E".repeat(201) }, "an error type over 200 characters"],
    [{ userId: "" }, "an empty user ID"],
    [{ userId: "u".repeat(201) }, "a user ID over 200 characters"],
    [{ feature: "f".repeat(101) }, "a feature over 100 characters"],
    [{ traceId: "xyz" }, "a trace ID that is not 32 hex characters"],
    [{ spanId: "00f067aa0ba902b7" }, "a span ID without its trace ID"],
    [{ finishReasons: Array.from({ length: 17 }, () => "stop") }, "17 finish reasons"],
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
    } finally {
      await app.close();
    }
  });

  test("a bad batch costs no lookup: refused even while PostgreSQL is down; 503 if the key cannot be looked up", async () => {
    const unreachable = createDatabase({
      connectionString: "postgres://unused@127.0.0.1:1/unused",
    });
    const broken = buildApp({
      db: unreachable,
      telemetry: { clickhouse: dashboard.reader.client },
    });
    try {
      const bad = await send({ v: 1, calls: [aiCall({ model: "" })] }, {}, broken);
      expect(bad.statusCode).toBe(400);
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
