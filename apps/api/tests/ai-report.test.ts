import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  costOf,
  type ModelPrice,
  priceOf,
  priceBookOf,
  pricedColumns,
  PRICES,
  type TokenCounts,
} from "../src/ai/prices.ts";
import { CHART_SERIES } from "../src/ai/report.ts";
import { purgeDeletedProjects, queueOrphanedProjects } from "../src/clickhouse/delete-events.ts";
import { QueryParams, queryRows } from "../src/clickhouse/query.ts";
import { deleteExpiredEvents } from "../src/retention/retention.ts";
import { nanosText } from "../src/telemetry/normalize.ts";
import { TRACE_MESSAGES } from "../src/telemetry/proto/definitions.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { encodeProtobuf, keyValues, secretKeyOf } from "./helpers/telemetry.ts";

/**
 * Check reports against OTLP calls, including cache pricing and users-area access.
 * See docs/ai-usage.md, "The report", ai/report.ts, ai/routes.ts, and ai/prices.ts.
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

beforeAll(async () => {
  dashboard = await signedInDashboard();
});

afterAll(async () => {
  await dashboard?.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

interface Call {
  model: string;
  provider?: string;
  /** How long before now it started. */
  agoMs: number;
  durationMs: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  feature?: string;
  userId?: string;
  errorType?: string;
  finish?: string;
  firstChunkSeconds?: number;
  service?: string;
  environment?: string;
}

/** Model calls, as an OTLP traces request, one resource per service and environment. */
function request(calls: Call[]) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const groups = Map.groupBy(
    calls,
    (call) => `${call.service ?? "assistant"}\n${call.environment ?? "production"}`,
  );
  return encodeProtobuf(TRACE_MESSAGES, {
    resourceSpans: [...groups].map(([key, group]) => {
      const [service, environment] = key.split("\n");
      return {
        resource: {
          attributes: keyValues({
            "service.name": service ?? "",
            "deployment.environment.name": environment ?? "",
          }),
        },
        scopeSpans: [
          {
            spans: group.map((call) => {
              const start = nowNs - BigInt(call.agoMs) * 1_000_000n;
              const attributes: Record<string, string | number> = {
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": call.provider ?? "openai",
                "gen_ai.request.model": call.model,
                "gen_ai.usage.input_tokens": call.input ?? 0,
                "gen_ai.usage.output_tokens": call.output ?? 0,
                "gen_ai.usage.cache_read.input_tokens": call.cacheRead ?? 0,
                "gen_ai.usage.cache_write.input_tokens": call.cacheWrite ?? 0,
                ...(call.feature === undefined ? {} : { "ottertrail.feature": call.feature }),
                ...(call.userId === undefined ? {} : { "user.id": call.userId }),
                ...(call.errorType === undefined ? {} : { "error.type": call.errorType }),
                ...(call.finish === undefined
                  ? {}
                  : { "gen_ai.response.finish_reasons": JSON.stringify([call.finish]) }),
                ...(call.firstChunkSeconds === undefined
                  ? {}
                  : { "gen_ai.response.time_to_first_chunk": call.firstChunkSeconds }),
              };
              return {
                traceId: Buffer.from(hex(16), "hex"),
                spanId: Buffer.from(hex(8), "hex"),
                name: `chat ${call.model}`,
                kind: 3,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(start + BigInt(call.durationMs) * 1_000_000n),
                attributes: keyValues(attributes),
                ...(call.errorType === undefined ? {} : { status: { code: 2 } }),
              };
            }),
          },
        ],
      };
    }),
  });
}

async function send(projectId: string, calls: Call[] | Buffer) {
  const response = await dashboard.app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: {
      "content-type": "application/x-protobuf",
      authorization: `Bearer ${await secretKeyOf(dashboard.db, projectId)}`,
    },
    payload: Buffer.isBuffer(calls) ? calls : request(calls),
  });
  expect(response.statusCode).toBe(200);
}

function get(path: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    method: "GET",
    url: `/api${path}`,
    headers: { cookie, origin: PUBLIC_URL },
  });
}

async function report(path: string, cookie = dashboard.cookie) {
  const response = await get(path, cookie);
  expect({ path, status: response.statusCode }).toEqual({ path, status: 200 });
  return response.json();
}

const SONNET = "claude-sonnet-4-6";
const MINI = "gpt-5.4-mini";
const LOCAL = "llama3.3:70b";

/** The calls of the report's project: this period's, another environment's, and the period before. */
const CALLS: Call[] = [
  ...[1000, 2000, 3000].map((durationMs, index) => ({
    model: SONNET,
    provider: "anthropic",
    agoMs: HOUR + index * 1000,
    durationMs,
    input: 1000,
    output: 200,
    cacheRead: 600,
    cacheWrite: 100,
    feature: "support-chat",
    userId: "u1",
    firstChunkSeconds: 0.5,
    finish: index === 0 ? "max_tokens" : "end_turn",
  })),
  {
    model: MINI,
    agoMs: 2 * HOUR,
    durationMs: 400,
    input: 500,
    output: 50,
    feature: "support-chat",
    userId: "u2",
  },
  {
    model: MINI,
    agoMs: 2 * HOUR + 1000,
    durationMs: 600,
    input: 500,
    output: 50,
    feature: "support-chat",
    userId: "u2",
    errorType: "timeout",
  },
  {
    model: LOCAL,
    provider: "ollama",
    agoMs: 3 * HOUR,
    durationMs: 5000,
    input: 100,
    output: 10,
    userId: "u1",
  },
  {
    model: MINI,
    agoMs: 4 * HOUR,
    durationMs: 100,
    input: 200,
    output: 20,
    feature: "nightly",
    service: "batch",
  },
  // Another environment's.
  { model: MINI, agoMs: HOUR, durationMs: 100, input: 9, output: 9, environment: "staging" },
  // The period before.
  ...[0, 1].map((index) => ({
    model: MINI,
    agoMs: 8 * DAY + index * 1000,
    durationMs: 300,
    input: 100,
    output: 10,
    feature: "support-chat",
  })),
];

const priceFor = (model: string) => {
  const price = priceOf(model);
  if (price === null) throw new Error(`${model} has no price`);
  return price;
};

/** What the calls cost, worked out here from the price table. */
const costOfCalls = (calls: Call[]) =>
  calls.reduce(
    (sum, call) =>
      sum +
      (priceOf(call.model) === null
        ? 0
        : costOf(priceFor(call.model), {
            input: call.input ?? 0,
            output: call.output ?? 0,
            cacheRead: call.cacheRead ?? 0,
            cacheWrite: call.cacheWrite ?? 0,
          })),
    0,
  );

const current = CALLS.filter(
  (call) => call.agoMs < 7 * DAY && (call.environment ?? "production") === "production",
);

let projectId = "";

beforeAll(async () => {
  projectId = (await insertProject(dashboard.db, { name: "Assistant" })).id;
  await send(projectId, CALLS);
});

const path = (query = "") => `/projects/${projectId}/ai?period=7d${query}`;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const member = (email: string, areas: Record<string, string>) =>
  signedInUser(dashboard, {
    name: email,
    email,
    grants: {
      projects: [projectId],
      areas: {
        web_analytics: "none",
        product_analytics: "none",
        errors: "none",
        replays: "none",
        users: "none",
        monitoring: "none",
        ai: "none",
        uptime_alerts: "none",
        ...areas,
      },
    },
  });

async function aiRows(id: string): Promise<number> {
  const result = await dashboard.reader.client.query({
    query: "SELECT count() AS n FROM ai_calls WHERE project_id = {project:UUID}",
    query_params: { project: id },
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ n: string }>();
  return Number(row?.n ?? 0);
}

const rowAt = (project: string, id: string, agoDays: number) => ({
  project_id: project,
  timestamp: nanosText(BigInt(Date.now() - agoDays * DAY) * 1_000_000n),
  id,
  model: MINI,
});

describe("the price table", () => {
  test("every entry names its source, the day it was checked, and prices that are numbers", () => {
    const wrong = PRICES.filter(
      (entry) =>
        !entry.source.startsWith("https://") ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.checked) ||
        entry.ids.length === 0 ||
        ![entry.input, entry.output].every((price) => Number.isFinite(price) && price >= 0),
    );
    expect(wrong).toEqual([]);
    const ids = PRICES.flatMap((entry) => entry.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id !== id.toLowerCase())).toEqual([]);
    expect(new Set(PRICES.map((entry) => entry.provider))).toEqual(
      new Set(["openai", "anthropic", "google", "mistral", "aws.bedrock"]),
    );
  });

  test("a model matches its exact ID in any case, then the longest prefix; others have no price", () => {
    expect(priceOf("Claude-Sonnet-4-6")?.label).toBe("Claude Sonnet 4.6");
    expect(priceOf("us.anthropic.claude-sonnet-4-6")?.provider).toBe("aws.bedrock");
    expect(priceOf("gpt-4o-2024-08-06")?.label).toBe("GPT-4o");
    // Google Cloud (Google managed) IDs.
    expect(priceOf("claude-opus-4-1@20250805")?.label).toBe("Claude Opus 4.1");
    expect(priceOf("claude-opus-4@20250514")?.label).toBe("Claude Opus 4");
    expect(priceOf("claude-sonnet-4@20250514")?.label).toBe("Claude Sonnet 4");
    expect(priceOf("llama3.3:70b")).toBeNull();
    expect(priceOf("")).toBeNull();
  });

  test("cache reads and writes are priced apart, the rest of the input as input", () => {
    const price: ModelPrice = {
      provider: "anthropic",
      label: "Test",
      ids: ["test"],
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      source: "https://example.com",
      checked: "2026-11-22",
    };
    const tokens: TokenCounts = {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 600_000,
      cacheWrite: 100_000,
    };
    // 300,000 base at 3, 600,000 at 0.3, 100,000 at 3.75, 100,000 out at 15.
    expect(costOf(price, tokens)).toBeCloseTo(0.9 + 0.18 + 0.375 + 1.5, 10);
    // No separate cache price: cached tokens cost as input.
    expect(costOf({ ...price, cacheRead: null, cacheWrite: null }, tokens)).toBeCloseTo(
      3 + 1.5,
      10,
    );
    // Less input than cached: a sender that counts cached tokens apart, as
    // Anthropic's API does. All the input is base input, the cache apart.
    expect(costOf(price, { input: 10, output: 0, cacheRead: 20, cacheWrite: 0 })).toBeCloseTo(
      (10 * 3 + 20 * 0.3) / 1e6,
      12,
    );
    expect(
      costOf(price, { input: 50_000, output: 0, cacheRead: 600_000, cacheWrite: 100_000 }),
    ).toBeCloseTo((50_000 * 3 + 600_000 * 0.3 + 100_000 * 3.75) / 1e6, 12);
    // Counted apart with more uncached input than cached (Anthropic's API):
    // 1,000 uncached at 3 and 500 cache reads at 0.30, nothing taken off.
    const anthropic = { input: 1000, output: 0, cacheRead: 500, cacheWrite: 0 };
    expect(costOf(price, { ...anthropic, inputIncludesCache: false })).toBeCloseTo(0.00315, 12);
    // The same counts with the cache inside the input: 500 uncached.
    expect(costOf(price, { ...anthropic, inputIncludesCache: true })).toBeCloseTo(0.00165, 12);
    // A count said to hold its cache but smaller than it cannot: counted apart.
    expect(
      costOf(price, {
        input: 10,
        output: 0,
        cacheRead: 20,
        cacheWrite: 0,
        inputIncludesCache: true,
      }),
    ).toBeCloseTo((10 * 3 + 20 * 0.3) / 1e6, 12);
    // Reasoning counted apart from the output, as Gemini's API does: priced as output too.
    const gemini = { input: 0, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 5000 };
    expect(costOf(price, { ...gemini, outputIncludesReasoning: false })).toBeCloseTo(
      (5200 * 15) / 1e6,
      12,
    );
    expect(costOf(price, gemini)).toBeCloseTo((200 * 15) / 1e6, 12);
  });

  test("ClickHouse works out the same cost, matching exactly, then by the longest prefix", async () => {
    const table: ModelPrice[] = [
      {
        provider: "openai",
        label: "A",
        ids: ["model-a"],
        input: 2,
        output: 8,
        cacheRead: 0.5,
        cacheWrite: null,
        source: "https://example.com",
        checked: "2026-11-22",
      },
      {
        provider: "openai",
        label: "Short",
        ids: [],
        prefixes: ["model-b"],
        input: 1,
        output: 1,
        cacheRead: null,
        cacheWrite: null,
        source: "https://example.com",
        checked: "2026-11-22",
      },
      {
        provider: "openai",
        label: "Long",
        ids: [],
        prefixes: ["model-b-2026"],
        input: 4,
        output: 4,
        cacheRead: null,
        cacheWrite: 10,
        source: "https://example.com",
        checked: "2026-11-22",
      },
    ];
    const project = randomUUID();
    const row = (id: string, model: string, tokens: TokenCounts) => ({
      project_id: project,
      timestamp: nanosText(BigInt(Date.now()) * 1_000_000n),
      id,
      model,
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_tokens: tokens.cacheRead,
      cache_write_tokens: tokens.cacheWrite,
      reasoning_tokens: tokens.reasoning ?? 0,
      ...(tokens.inputIncludesCache === undefined
        ? {}
        : { input_includes_cache: tokens.inputIncludesCache }),
      ...(tokens.outputIncludesReasoning === undefined
        ? {}
        : { output_includes_reasoning: tokens.outputIncludesReasoning }),
    });
    // 200 output and 5,000 reasoning tokens, counted apart (Gemini's API), and in.
    const thoughts = { input: 0, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 5000 };
    // More uncached input than cached, counted apart, as Anthropic's API does.
    const apart = {
      input: 1000,
      output: 0,
      cacheRead: 500,
      cacheWrite: 0,
      inputIncludesCache: false,
    };
    const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 400_000, cacheWrite: 100_000 };
    const exclusive = { input: 100_000, output: 1000, cacheRead: 400_000, cacheWrite: 100_000 };
    await dashboard.reader.client.insert({
      table: "ai_calls",
      values: [
        row("a", "Model-A", tokens),
        row("b", "model-b-1", tokens),
        row("c", "model-b-2026-01", tokens),
        row("d", "model-c", tokens),
        // Cached tokens counted apart from the input.
        row("e", "model-a", exclusive),
        row("f", "model-a", apart),
        row("g", "model-a", { ...thoughts, outputIncludesReasoning: false }),
        row("h", "model-a", thoughts),
      ],
      format: "JSONEachRow",
    });
    const params = new QueryParams();
    const rows = await queryRows<{
      id: string;
      cost: number;
      priced: boolean | number;
      all_output_tokens: string;
    }>(
      dashboard.reader,
      `SELECT id, cost, priced, all_output_tokens FROM (SELECT *, ${pricedColumns(params, priceBookOf([], table))} FROM ai_calls
       WHERE project_id = ${params.add(project, "UUID")}) ORDER BY id`,
      params,
    );
    const [a, short, long] = table;
    expect(rows.map((item) => [item.id, Number(item.priced)])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 1],
      ["d", 0],
      ["e", 1],
      ["f", 1],
      ["g", 1],
      ["h", 1],
    ]);
    expect(rows.map((item) => item.cost)).toEqual([
      expect.closeTo(costOf(a as ModelPrice, tokens), 9),
      expect.closeTo(costOf(short as ModelPrice, tokens), 9),
      expect.closeTo(costOf(long as ModelPrice, tokens), 9),
      0,
      // 100,000 at 2, 400,000 at 0.5, 100,000 at 2 (no write price), 1,000 at 8.
      expect.closeTo((100_000 * 2 + 400_000 * 0.5 + 100_000 * 2 + 1000 * 8) / 1e6, 9),
      // 1,000 at 2 and 500 at 0.5: the input is all uncached.
      expect.closeTo(costOf(a as ModelPrice, apart), 12),
      expect.closeTo((5200 * 8) / 1e6, 12),
      // Stored without saying, as rows before migration 0014: reasoning in the output.
      expect.closeTo((200 * 8) / 1e6, 12),
    ]);
    expect(costOf(a as ModelPrice, apart)).toBeCloseTo((1000 * 2 + 500 * 0.5) / 1e6, 12);
    // The output added up holds the reasoning a call counted apart, as its cost does.
    expect(
      rows.filter((item) => ["g", "h"].includes(item.id)).map((item) => item.all_output_tokens),
    ).toEqual(["5200", "200"]);
    expect(costOf(a as ModelPrice, exclusive)).toBeCloseTo(
      (100_000 * 2 + 400_000 * 0.5 + 100_000 * 2 + 1000 * 8) / 1e6,
      9,
    );
  });
});

describe("the report", () => {
  test("totals, against the period before, with models without a price counted apart", async () => {
    const body = await report(path());
    expect(body).toMatchObject({
      environment: "production",
      environments: ["production", "staging"],
      services: ["assistant", "batch"],
      filterOptions: {
        services: ["assistant", "batch"],
        providers: ["anthropic", "ollama", "openai"],
        models: [SONNET, MINI, LOCAL].toSorted(),
        features: ["", "nightly", "support-chat"],
      },
      received: true,
      usersHidden: false,
    });
    expect(body.totals).toEqual({
      calls: 7,
      inputTokens: 4300,
      outputTokens: 730,
      cacheReadTokens: 1800,
      cacheWriteTokens: 300,
      reasoningTokens: 0,
      costUsd: expect.closeTo(costOfCalls(current), 9),
      cacheReadShare: 1800 / 4300,
      // 100, 400, 600, 1,000, 2,000, 3,000, 5,000 ms: a t-digest of so few
      // keeps each, and its 95th percentile is the slowest.
      p95Ms: expect.closeTo(5000, 3),
      failed: 1,
      failedShare: 1 / 7,
      noPriceCalls: 1,
      noPriceModels: [LOCAL],
    });
    expect(body.previous).toMatchObject({
      totals: { calls: 2, inputTokens: 200, failed: 0, noPriceCalls: 0 },
    });
    expect(body.previous.totals.costUsd).toBeCloseTo(
      costOfCalls(CALLS.filter((call) => call.agoMs > 7 * DAY)),
      9,
    );
  });

  test("by model and by feature: calls, tokens, cost, latency, time to first chunk, failures, cut off", async () => {
    const { models, features, failures } = await report(path());
    expect(models).toEqual([
      expect.objectContaining({
        model: SONNET,
        provider: "anthropic",
        other: false,
        priced: true,
        calls: 3,
        inputTokens: 3000,
        costUsd: expect.closeTo(costOfCalls(current.filter((call) => call.model === SONNET)), 9),
        p50Ms: expect.closeTo(2000, 3),
        p95Ms: expect.closeTo(3000, 3),
        firstChunkP50Ms: expect.closeTo(500, 3),
        failed: 0,
        cutOff: 1,
        cutOffShare: 1 / 3,
      }),
      expect.objectContaining({
        model: MINI,
        provider: "openai",
        priced: true,
        calls: 3,
        failed: 1,
        failedShare: 1 / 3,
        firstChunkP50Ms: null,
        cutOff: 0,
      }),
      expect.objectContaining({ model: LOCAL, priced: false, costUsd: 0, noPriceCalls: 1 }),
    ]);
    expect(
      features.map((row: { feature: string; calls: number }) => [row.feature, row.calls]),
    ).toEqual([
      ["support-chat", 5],
      ["nightly", 1],
      ["", 1],
    ]);
    expect(failures).toEqual([{ errorType: "timeout", calls: 1, lastAt: expect.any(String) }]);
  });

  test("by user: the most cost first, calls without a user left out", async () => {
    const { users } = await report(path());
    expect(users).toEqual([
      expect.objectContaining({ userId: "u1", calls: 4, noPriceCalls: 1 }),
      expect.objectContaining({ userId: "u2", calls: 2, failed: 1 }),
    ]);
  });

  test.each([
    ["&model=gpt-5.4-mini", 3],
    ["&provider=anthropic", 3],
    ["&feature=", 1],
    ["&feature=support-chat", 5],
    ["&service=batch", 1],
    ["&environment=staging", 1],
    ["&model=gpt-5.4-mini&feature=nightly", 1],
  ])("filtered by %s: %i calls", async (query, calls) => {
    const body = await report(path(query));
    expect(body.totals.calls).toBe(calls);
    expect(sum(body.models.map((row: { calls: number }) => row.calls))).toBe(calls);
  });

  test("one user's calls: totals, models, features, the chart, and the latest calls", async () => {
    const body = await report(path("&user=u1"));
    const mine = current.filter((call) => call.userId === "u1");
    expect(body.totals).toMatchObject({ calls: 4, failed: 0, noPriceCalls: 1 });
    expect(body.totals.costUsd).toBeCloseTo(costOfCalls(mine), 9);
    expect(body.models.map((row: { model: string }) => row.model)).toEqual([SONNET, LOCAL]);
    expect(body.features.map((row: { feature: string }) => row.feature)).toEqual([
      "support-chat",
      "",
    ]);
    expect(body.users).toEqual([expect.objectContaining({ userId: "u1", calls: 4 })]);
    // Whether the project has calls at all stays the project's.
    expect((await report(path("&user=nobody"))).totals.calls).toBe(0);
    expect((await report(path("&user=nobody"))).received).toBe(true);
    const chart = await report(`/projects/${projectId}/ai/chart?period=7d&user=u2`);
    expect(sum(chart.total.calls)).toBe(2);
    const { calls } = await report(`/projects/${projectId}/ai/calls?period=7d&user=u2`);
    expect(calls.map((call: { userId: string }) => call.userId)).toEqual(["u2", "u2"]);
  });

  test.each([
    "?period=7d&user=",
    `?period=7d&user=${"u".repeat(201)}`,
    "?period=7d&user=%01",
    "?period=7d&model=",
    `?period=7d&model=${"m".repeat(101)}`,
    "?period=7d&provider=%01",
    "?period=7d&from=2026-11-01",
  ])("refuses %s", async (query) => {
    const response = await get(`/projects/${projectId}/ai${query}`);
    expect(response.statusCode).toBe(400);
  });

  test("calls older than the 30 days of spans are read: AI calls are kept as long as events", async () => {
    const old = (await insertProject(dashboard.db, { name: "Old calls" })).id;
    await dashboard.reader.client.insert({
      table: "ai_calls",
      values: [
        {
          project_id: old,
          timestamp: nanosText(BigInt(Date.now() - 60 * DAY) * 1_000_000n),
          id: "old",
          model: MINI,
          environment: "production",
          input_tokens: 10,
          // Counted apart from the input, by its sender: the share is of all 30.
          cache_read_tokens: 20,
        },
      ],
      format: "JSONEachRow",
    });
    const body = await report(`/projects/${old}/ai?period=90d`);
    // The input is all 30, the cache reads with it, as the share counts it.
    expect(body.totals).toMatchObject({ calls: 1, inputTokens: 30, cacheReadShare: 20 / 30 });
  });

  test("a project without calls: zeros, nulls, and received false", async () => {
    const empty = (await insertProject(dashboard.db, { name: "No AI" })).id;
    const body = await report(`/projects/${empty}/ai?period=today`);
    expect(body).toMatchObject({
      received: false,
      models: [],
      features: [],
      users: [],
      failures: [],
      totals: {
        calls: 0,
        costUsd: 0,
        cacheReadShare: null,
        p95Ms: null,
        failedShare: null,
        noPriceModels: [],
      },
    });
  });
});

describe("the chart", () => {
  test("cost, tokens, calls, and p95 per bucket, split by model, the costliest first", async () => {
    const chart = await report(`/projects/${projectId}/ai/chart?period=7d&split=model`);
    expect(chart).toMatchObject({ split: "model", buckets: chart.bucketStarts.length });
    expect(sum(chart.total.calls)).toBe(7);
    expect(sum(chart.total.tokens)).toBe(4300 + 730);
    expect(sum(chart.total.costUsd)).toBeCloseTo(costOfCalls(current), 9);
    expect(chart.series.map((line: { key: string }) => line.key)).toEqual([SONNET, MINI, LOCAL]);
    expect(sum(chart.series[0].calls)).toBe(3);
  });

  test(`split by feature, at most ${CHART_SERIES} lines and Other`, async () => {
    const many = (await insertProject(dashboard.db, { name: "Many features" })).id;
    await send(
      many,
      Array.from({ length: CHART_SERIES + 2 }, (_, index) => ({
        model: MINI,
        agoMs: HOUR,
        durationMs: 10,
        input: 1000 * (CHART_SERIES + 2 - index),
        feature: `f-${String(index).padStart(2, "0")}`,
      })),
    );
    // The last 7 days, not today: an hour ago is yesterday just after midnight.
    const chart = await report(`/projects/${many}/ai/chart?period=7d&split=feature`);
    const keys = chart.series.map((line: { key: string; other: boolean }) => [
      line.key,
      line.other,
    ]);
    expect(keys).toHaveLength(CHART_SERIES + 1);
    expect(keys.at(-1)).toEqual(["", true]);
    expect(keys[0]).toEqual(["f-00", false]);
  });
});

describe("the latest calls", () => {
  test("a retried request's calls are listed once", async () => {
    const retried = (await insertProject(dashboard.db, { name: "Retried" })).id;
    const body = request(CALLS.slice(0, 3));
    await send(retried, body);
    await send(retried, body);
    const { calls } = await report(`/projects/${retried}/ai/calls?period=7d`);
    expect(calls).toHaveLength(3);
  });

  test("newest first, with their trace, span, and estimated cost", async () => {
    const { calls } = await report(`/projects/${projectId}/ai/calls?period=7d`);
    expect(calls).toHaveLength(7);
    expect(calls[0]).toMatchObject({
      model: SONNET,
      feature: "support-chat",
      userId: "u1",
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      startNs: expect.stringMatching(/^[0-9]+$/),
      finishReasons: ["max_tokens"],
      costUsd: expect.any(Number),
    });
    expect(calls.find((call: { model: string }) => call.model === LOCAL)?.costUsd).toBeNull();
    const span = await get(
      `/projects/${projectId}/traces/${calls[0].traceId}/spans/${calls[0].spanId}?start=${calls[0].startNs}`,
    );
    expect(span.json()).toMatchObject({ span: { name: `chat ${SONNET}` } });
  });
});

describe("access", () => {
  test("AI at view; without users, no breakdown by user, no user on a call, and no user filter", async () => {
    const watcher = await member("ai-only@example.com", { ai: "view" });
    const body = await report(`/projects/${projectId}/ai?period=7d`, watcher.cookie);
    expect(body).toMatchObject({ users: null, usersHidden: true, totals: { calls: 7 } });
    const { calls, usersHidden } = await report(
      `/projects/${projectId}/ai/calls?period=7d`,
      watcher.cookie,
    );
    expect(usersHidden).toBe(true);
    expect(calls.map((call: { userId: string | null }) => call.userId)).toEqual(
      Array.from({ length: 7 }, () => null),
    );

    for (const suffix of ["", "/chart", "/calls"]) {
      const filtered = await get(
        `/projects/${projectId}/ai${suffix}?period=7d&user=u1`,
        watcher.cookie,
      );
      expect(filtered.statusCode).toBe(403);
    }

    const both = await member("ai-users@example.com", { ai: "view", users: "view" });
    expect((await report(`/projects/${projectId}/ai?period=7d`, both.cookie)).users).toHaveLength(
      2,
    );
  });

  test.each(["", "/chart", "/calls"])(
    "…/ai%s: 403 without AI (monitoring is not enough), 401 signed out, 404 elsewhere",
    async (suffix) => {
      const outsider = await member(`ai-none${suffix.replace("/", "-")}@example.com`, {
        users: "view",
        monitoring: "view",
      });
      expect((await get(`/projects/${projectId}/ai${suffix}`, outsider.cookie)).statusCode).toBe(
        403,
      );
      expect((await get(`/projects/${projectId}/ai${suffix}`, "")).statusCode).toBe(401);
      expect((await get(`/projects/${randomUUID()}/ai${suffix}`)).statusCode).toBe(404);
    },
  );
});

// ClickHouse carries out a DELETE in the background, which takes seconds.
describe("retention and deletion", { timeout: 60_000 }, () => {
  test("kept as long as the project's events: older calls go with older events", async () => {
    const kept = (await insertProject(dashboard.db, { name: "Keeps 30 days", retention_days: 30 }))
      .id;
    const forever = (await insertProject(dashboard.db, { name: "Keeps everything" })).id;
    await dashboard.reader.client.insert({
      table: "ai_calls",
      values: [rowAt(kept, "old", 45), rowAt(kept, "new", 2), rowAt(forever, "old", 400)],
      format: "JSONEachRow",
    });
    const results = await deleteExpiredEvents(dashboard.db, dashboard.reader.client);
    expect(results.find((result) => result.projectId === kept)?.deleted).toBe(1);
    expect(await aiRows(kept)).toBe(1);
    expect(await aiRows(forever)).toBe(1);
  });

  test("deleted with their project, and an orphan's found by the sweep", async () => {
    const gone = (await insertProject(dashboard.db, { name: "Deleted" })).id;
    const orphan = randomUUID();
    await dashboard.reader.client.insert({
      table: "ai_calls",
      values: [rowAt(gone, "a", 1), rowAt(orphan, "b", 1)],
      format: "JSONEachRow",
    });
    const deleted = await dashboard.app.inject({
      method: "DELETE",
      url: `/api/projects/${gone}`,
      headers: { origin: PUBLIC_URL, cookie: dashboard.cookie },
      payload: { confirmName: "Deleted" },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await queueOrphanedProjects(dashboard.db, dashboard.reader.client)).toMatchObject({
      queued: true,
    });
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);
    expect(await aiRows(gone)).toBe(0);
    expect(await aiRows(orphan)).toBe(0);
  });
});
