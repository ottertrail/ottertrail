import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { CALLS_PAGE_SIZE, MAX_CONVERSATIONS } from "../src/ai/call-list.ts";
import { nanosText } from "../src/telemetry/normalize.ts";
import { TRACE_MESSAGES } from "../src/telemetry/proto/definitions.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { encodeProtobuf, keyValues, secretKeyOf } from "./helpers/telemetry.ts";

/**
 * The AI calls list and its conversations (docs/ai-usage.md, "The calls
 * list"; ai/call-list.ts, ai/call-routes.ts), against real PostgreSQL and
 * ClickHouse: the list's filters and keyset paging, a retried batch listed
 * once (FINAL), one call with its price's source and whether its trace is
 * kept, the totals and cost matching the AI page's, conversations grouped
 * from spans and from calls sent over HTTP, bounded, and access with and
 * without the users area.
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let secretKey = "";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SONNET = "claude-sonnet-4-6";
const MINI = "gpt-5-mini";
const LOCAL = "llama3.3:70b";
/** A conversation ID a path must encode. */
const THREAD = "tenant 7/thread 1";
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function aiCall(agoMs: number, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    occurredAt: Date.now() - agoMs,
    provider: "anthropic",
    model: SONNET,
    operation: "chat",
    inputTokens: 1000,
    outputTokens: 200,
    durationMs: 1500,
    ...overrides,
  };
}

/** Three turns of one support chat by u1, one failed; two of a summary by u2; two of none. */
const PRODUCTION = [
  aiCall(3 * HOUR, { conversationId: "c-1", userId: "u1", feature: "support-chat" }),
  aiCall(3 * HOUR - MINUTE, {
    conversationId: "c-1",
    userId: "u1",
    feature: "support-chat",
    errorType: "RateLimitError",
    durationMs: 300,
  }),
  aiCall(3 * HOUR - 2 * MINUTE, {
    conversationId: "c-1",
    userId: "u1",
    feature: "support-chat",
    cacheReadTokens: 400,
    finishReasons: ["max_tokens"],
  }),
  aiCall(HOUR, {
    provider: "openai",
    model: MINI,
    conversationId: THREAD,
    userId: "u2",
    feature: "summarize",
    service: "worker",
  }),
  aiCall(50 * MINUTE, {
    provider: "openai",
    model: MINI,
    conversationId: THREAD,
    userId: "u2",
    feature: "summarize",
    service: "worker",
  }),
  aiCall(30 * MINUTE, { provider: "ollama", model: LOCAL, traceId: hex(16), spanId: hex(8) }),
  aiCall(20 * MINUTE, { provider: "openai", model: MINI }),
];
/** The same conversation in staging: never mixed with production's. */
const STAGING = [aiCall(10 * MINUTE, { conversationId: "c-1", userId: "u1" })];

async function sendCalls(calls: object[], environment?: string) {
  const response = await dashboard.app.inject({
    method: "POST",
    url: "/api/ai-calls",
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify({ v: 1, ...(environment === undefined ? {} : { environment }), calls }),
  });
  expect(response.statusCode).toBe(202);
}

/** A model call in a span, with its conversation's ID, over OTLP. */
async function sendSpan(key: string, conversation: string, agoMs: number) {
  const start = BigInt(Date.now() - agoMs) * 1_000_000n;
  const response = await dashboard.app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${key}` },
    payload: encodeProtobuf(TRACE_MESSAGES, {
      resourceSpans: [
        {
          resource: { attributes: keyValues({ "service.name": "assistant" }) },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: Buffer.from(hex(16), "hex"),
                  spanId: Buffer.from(hex(8), "hex"),
                  name: `chat ${SONNET}`,
                  kind: 3,
                  startTimeUnixNano: String(start),
                  endTimeUnixNano: String(start + 900_000_000n),
                  attributes: keyValues({
                    "gen_ai.operation.name": "chat",
                    "gen_ai.provider.name": "anthropic",
                    "gen_ai.request.model": SONNET,
                    "gen_ai.usage.input_tokens": 100,
                    "gen_ai.usage.output_tokens": 10,
                    "gen_ai.conversation.id": conversation,
                  }),
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  expect(response.statusCode).toBe(200);
}

/** Rows written straight to ai_calls: many, or older than a call over HTTP may be. */
async function insertCalls(rows: Record<string, unknown>[]) {
  await dashboard.reader.client.insert({ table: "ai_calls", values: rows, format: "JSONEachRow" });
}

const rowAt = (project: string, agoMs: number, extra: Record<string, unknown> = {}) => ({
  project_id: project,
  timestamp: nanosText(BigInt(Date.now() - agoMs) * 1_000_000n),
  id: randomUUID(),
  provider: "openai",
  environment: "production",
  model: MINI,
  input_tokens: 10,
  output_tokens: 5,
  duration_ns: 1_000_000,
  ...extra,
});

function get(path: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    method: "GET",
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie, origin: PUBLIC_URL },
  });
}

async function ok(path: string, cookie = dashboard.cookie) {
  const response = await get(path, cookie);
  expect({ path, status: response.statusCode }).toEqual({ path, status: 200 });
  return response.json();
}

const list = (query = "") => ok(`/ai/call-list?period=7d${query}`);
const ids = (calls: { id: string }[]) => calls.map((call) => call.id);
/** The IDs of calls as sent, newest first: the list's order. */
const newestFirst = (calls: { id: string; occurredAt: number }[]) =>
  ids(calls.toSorted((a, b) => b.occurredAt - a.occurredAt));

beforeAll(async () => {
  dashboard = await signedInDashboard();
  projectId = (await insertProject(dashboard.db, { name: "Assistant" })).id;
  secretKey = await secretKeyOf(dashboard.db, projectId);
  await sendCalls(PRODUCTION);
  // Retried: the same rows, which the list shows once.
  await sendCalls(PRODUCTION);
  await sendCalls(STAGING, "staging");
  // Merged, so the totals, which read without FINAL as the AI page's do, count each call once.
  await dashboard.reader.client.command({ query: "OPTIMIZE TABLE ai_calls FINAL" });
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET …/ai/call-list", () => {
  test("every call, newest first, each once, with what the list and detail show", async () => {
    const body = await list();
    expect(ids(body.calls)).toEqual(newestFirst(PRODUCTION));
    expect(body).toMatchObject({
      environment: "production",
      environments: ["production", "staging"],
      usersHidden: false,
      pageSize: CALLS_PAGE_SIZE,
      next: null,
      received: true,
    });
    const failed = body.calls.find((call: { failed: boolean }) => call.failed);
    expect(failed).toEqual({
      id: PRODUCTION[1]?.id,
      traceId: "",
      spanId: "",
      startNs: expect.stringMatching(/^\d+$/),
      at: new Date(PRODUCTION[1]?.occurredAt ?? 0).toISOString(),
      service: "",
      environment: "production",
      release: "",
      provider: "anthropic",
      model: SONNET,
      operation: "chat",
      feature: "support-chat",
      userId: "u1",
      conversationId: "c-1",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      // 1,000 input at $3 and 200 output at $15 per million.
      costUsd: expect.closeTo(0.006, 9),
      durationMs: 300,
      firstChunkMs: null,
      failed: true,
      errorType: "RateLimitError",
      finishReasons: [],
    });
    const local = body.calls.find((call: { model: string }) => call.model === LOCAL);
    expect(local.costUsd).toBeNull();
  });

  test("the totals and cost are the AI page's for the same calls", async () => {
    const body = await list();
    const page = await ok("/ai?period=7d");
    expect(body.totals).toEqual({
      calls: page.totals.calls,
      costUsd: expect.closeTo(page.totals.costUsd, 9),
      failed: page.totals.failed,
      failedShare: expect.closeTo(page.totals.failedShare, 9),
      noPriceCalls: page.totals.noPriceCalls,
    });
    const listed = body.calls.reduce(
      (total: number, call: { costUsd: number | null }) => total + (call.costUsd ?? 0),
      0,
    );
    expect(body.totals).toMatchObject({ calls: PRODUCTION.length, failed: 1, noPriceCalls: 1 });
    expect(body.totals.costUsd).toBeCloseTo(listed, 9);
    // With a filter too.
    const filtered = await list(`&model=${MINI}`);
    expect(filtered.totals.costUsd).toBeCloseTo(
      (await ok(`/ai?period=7d&model=${MINI}`)).totals.costUsd,
      9,
    );
  });

  test.each([
    ["&model=gpt-5-mini", [3, 4, 6]],
    ["&provider=ollama", [5]],
    ["&feature=support-chat", [0, 1, 2]],
    ["&feature=", [5, 6]],
    ["&service=worker", [3, 4]],
    ["&user=u2", [3, 4]],
    ["&conversation=c-1", [0, 1, 2]],
    [`&conversation=${encodeURIComponent(THREAD)}`, [3, 4]],
    ["&status=failed", [1]],
    ["&user=u1&status=failed", [1]],
    ["&user=nobody", []],
  ])("filters %s", async (query, indexes) => {
    const body = await list(query);
    expect(ids(body.calls)).toEqual(
      newestFirst(indexes.map((index) => PRODUCTION[index] ?? aiCall(0))),
    );
    expect(body.totals.calls).toBe(indexes.length);
  });

  test("the environment's calls only", async () => {
    const body = await list("&environment=staging");
    expect(ids(body.calls)).toEqual(ids(STAGING));
  });

  test("refuses filters it cannot take", async () => {
    for (const query of [
      "&status=ok",
      "&user=",
      "&conversation=a%07b",
      `&conversation=${"c".repeat(201)}`,
      "&before=1-xyz",
    ]) {
      expect((await get(`/ai/call-list?period=7d${query}`)).statusCode).toBe(400);
    }
  });

  test("pages back with a cursor, past the first day, each call once", async () => {
    const paged = (await insertProject(dashboard.db, { name: "Paged" })).id;
    // 60 in the last hours, 190 more a day and a half back: the first day does not fill the second page.
    const rows = [
      ...Array.from({ length: 60 }, (_, index) => rowAt(paged, (index + 1) * MINUTE)),
      ...Array.from({ length: 190 }, (_, index) => rowAt(paged, 36 * HOUR + index * MINUTE)),
    ];
    await insertCalls(rows);
    // A copy of a row, before the merge.
    await insertCalls(rows.slice(0, 10));
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    const answers: object[] = [];
    do {
      const response: {
        statusCode: number;
        json: () => {
          calls: { id: string }[];
          next: string | null;
          totals: object | null;
          received: boolean | null;
          filterOptions: object | null;
        };
      } = await dashboard.app.inject({
        method: "GET",
        url: `/api/projects/${paged}/ai/call-list?period=7d${next === null ? "" : `&before=${next}`}`,
        headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      seen.push(...ids(body.calls));
      next = body.next;
      pages += 1;
      expect(body.calls.length).toBe(pages < 3 ? CALLS_PAGE_SIZE : 50);
      answers.push(body);
    } while (next !== null);
    expect(pages).toBe(3);
    // Only the first page counts the totals and the filter options: later ones skip them.
    const later = { totals: null, received: null, filterOptions: null };
    expect(answers).toMatchObject([
      { totals: { calls: expect.any(Number) }, received: true },
      later,
      later,
    ]);
    expect(seen).toEqual(rows.map((row) => row.id));
  });
});

describe("GET …/ai/calls/:callId", () => {
  test("one call by its ID, its price and where it comes from", async () => {
    const call = PRODUCTION[0];
    const at = new Date(call?.occurredAt ?? 0).toISOString();
    const body = await ok(`/ai/calls/${call?.id}?at=${at}`);
    expect(body).toMatchObject({
      timeZone: "UTC",
      usersHidden: false,
      traceRetentionDays: 30,
      traceKept: false,
      call: { id: call?.id, conversationId: "c-1", userId: "u1", environment: "production" },
      price: {
        source: "built_in",
        rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        checked: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        model: null,
        effectiveFrom: null,
      },
    });
    // Without its time, looked for over the last year.
    expect((await ok(`/ai/calls/${call?.id}`)).call.id).toBe(call?.id);
  });

  test("a call with a kept trace says so; one past the spans' retention, and one without a price, do not", async () => {
    const local = PRODUCTION[5];
    const body = await ok(`/ai/calls/${local?.id}`);
    expect(body).toMatchObject({ traceKept: true, price: null, call: { costUsd: null } });

    const old = rowAt(projectId, 40 * DAY, {
      trace_id: hex(16),
      span_id: hex(8),
      environment: "old",
    });
    await insertCalls([old]);
    expect(await ok(`/ai/calls/${old.id}`)).toMatchObject({
      traceKept: false,
      call: { id: old.id },
    });
  });

  test("a call the project does not have: 404", async () => {
    const response = await get(`/ai/calls/${randomUUID()}`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("no_such_call");
    expect((await get("/ai/calls/not-an-id")).statusCode).toBe(400);
  });
});

describe("GET …/ai/conversations", () => {
  test("the period's conversations by their last call, from calls over HTTP and from spans", async () => {
    await sendSpan(secretKey, "from-a-span", 5 * MINUTE);
    const body = await ok("/ai/conversations?period=7d");
    expect(body).toMatchObject({ usersHidden: false, limit: MAX_CONVERSATIONS, more: false });
    expect(body.conversations.map((row: { conversationId: string }) => row.conversationId)).toEqual(
      ["from-a-span", THREAD, "c-1"],
    );
    const chat = body.conversations[2];
    const calls = (await list("&conversation=c-1")).calls;
    expect(chat).toEqual({
      conversationId: "c-1",
      startedAt: new Date(PRODUCTION[0]?.occurredAt ?? 0).toISOString(),
      lastAt: new Date(PRODUCTION[2]?.occurredAt ?? 0).toISOString(),
      calls: 3,
      inputTokens: 3000,
      outputTokens: 600,
      costUsd: expect.closeTo(
        calls.reduce((total: number, call: { costUsd: number }) => total + call.costUsd, 0),
        9,
      ),
      noPriceCalls: 0,
      durationMs: 3300,
      failed: 1,
      userId: "u1",
      features: ["support-chat"],
      models: [SONNET],
    });
  });

  test("filters narrow the calls; failed keeps the conversations with a failed call, whole", async () => {
    const byModel = await ok(`/ai/conversations?period=7d&model=${MINI}`);
    expect(
      byModel.conversations.map((row: { conversationId: string }) => row.conversationId),
    ).toEqual([THREAD]);
    const failed = await ok("/ai/conversations?period=7d&status=failed");
    expect(failed.conversations).toMatchObject([{ conversationId: "c-1", calls: 3, failed: 1 }]);
    const staging = await ok("/ai/conversations?period=7d&environment=staging");
    expect(staging.conversations).toMatchObject([{ conversationId: "c-1", calls: 1 }]);
  });

  test("one conversation's calls in order, with its figures", async () => {
    const body = await ok(`/ai/conversations/${encodeURIComponent(THREAD)}?period=7d`);
    expect(body).toMatchObject({
      conversationId: THREAD,
      more: false,
      figures: { calls: 2, failed: 0, inputTokens: 2000, outputTokens: 400 },
    });
    expect(ids(body.calls)).toEqual([PRODUCTION[3]?.id, PRODUCTION[4]?.id]);
    // "failed" chooses conversations, not their calls.
    const whole = await ok("/ai/conversations/c-1?period=7d&status=failed");
    expect(whole.calls).toHaveLength(3);
    const none = await ok("/ai/conversations/nothing?period=7d");
    expect(none).toMatchObject({ figures: null, calls: [] });
  });

  test("at most the 1,000 with the latest calls, and says more were left out", async () => {
    const many = (await insertProject(dashboard.db, { name: "Many conversations" })).id;
    await insertCalls(
      Array.from({ length: MAX_CONVERSATIONS + 1 }, (_, index) =>
        rowAt(many, (index + 1) * 1000, { conversation_id: `conversation-${index}` }),
      ),
    );
    const response = await dashboard.app.inject({
      method: "GET",
      url: `/api/projects/${many}/ai/conversations?period=7d`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    });
    const body = response.json();
    expect(body.more).toBe(true);
    expect(body.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(body.conversations[0].conversationId).toBe("conversation-0");
    expect(body.conversations.at(-1).conversationId).toBe(`conversation-${MAX_CONVERSATIONS - 1}`);
  });
});

/** A member who views monitoring, with or without the users area. */
const member = (email: string, users: "none" | "view") =>
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
        users,
        monitoring: "view",
        uptime_alerts: "none",
      },
    },
  });

describe("access", () => {
  test("without the users area: no call names its user, and no user filter", async () => {
    const { cookie } = await member("monitoring@example.com", "none");
    const body = await ok("/ai/call-list?period=7d", cookie);
    expect(body.usersHidden).toBe(true);
    expect(body.calls.every((call: { userId: string | null }) => call.userId === null)).toBe(true);
    const refused = await get("/ai/call-list?period=7d&user=u1", cookie);
    expect(refused.statusCode).toBe(403);
    expect((await get("/ai/conversations?period=7d&user=u1", cookie)).statusCode).toBe(403);
    const conversations = await ok("/ai/conversations?period=7d", cookie);
    expect(
      conversations.conversations.every((row: { userId: string | null }) => row.userId === null),
    ).toBe(true);
    const one = await ok(`/ai/calls/${PRODUCTION[0]?.id}`, cookie);
    expect(one).toMatchObject({ usersHidden: true, call: { userId: null } });
    const conversation = await ok("/ai/conversations/c-1?period=7d", cookie);
    expect(
      conversation.calls.every((call: { userId: string | null }) => call.userId === null),
    ).toBe(true);
  });

  test("with it, calls name their user and the user filter works", async () => {
    const { cookie } = await member("users@example.com", "view");
    const body = await ok("/ai/call-list?period=7d&user=u1", cookie);
    expect(body.usersHidden).toBe(false);
    expect(body.calls).toHaveLength(3);
  });
});
