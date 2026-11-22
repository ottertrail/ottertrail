import type {
  AiCallDetail,
  AiCallPage,
  AiCallPrice,
  AiConversationDetail,
  AiConversationList,
  AiConversationRow,
  AiListedCall,
} from "../../src/lib/ai-calls-api.ts";

/**
 * The AI calls list's routes in the fake API (GET …/ai/call-list,
 * …/ai/calls/:callId, …/ai/conversations, …/ai/conversations/:id; the
 * API's own tests are apps/api/tests/ai-call-list.test.ts). The fixtures
 * are six calls of a support app on 16 Nov 2026, in Singapore: two
 * conversations of two turns each, and two calls of none.
 */
export interface FakeAiCalls {
  /** Every call, newest first; the fake filters and pages them. */
  calls: AiListedCall[];
  /** Calls a page holds: fewer than the API's 100, to page with few fixtures. */
  pageSize: number;
  /** Whether the project has any AI call at all. */
  received: boolean;
  /** Answers GET …/ai/call-list instead, such as a failure. */
  list?: (query: URLSearchParams) => Response | Promise<Response>;
}

const RANGE = {
  timeZone: "Asia/Singapore",
  firstDay: "2026-11-10",
  lastDay: "2026-11-16",
};

/** A call's ID: a UUID, as a call sent over HTTP has. */
export const aiCallId = (index: number) =>
  `ca11ca11-0000-4000-8000-${String(index).padStart(12, "0")}`;

const base: Omit<AiListedCall, "id" | "at" | "startNs"> = {
  traceId: "",
  spanId: "",
  service: "support-api",
  environment: "production",
  release: "2.14.0",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  operation: "chat",
  feature: "support-chat",
  userId: null,
  conversationId: "",
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0.006,
  durationMs: 1500,
  firstChunkMs: null,
  failed: false,
  errorType: "",
  finishReasons: ["end_turn"],
};

const call = (index: number, at: string, overrides: Partial<AiListedCall>): AiListedCall => ({
  ...base,
  id: aiCallId(index),
  at,
  startNs: `${Date.parse(at)}000000`,
  ...overrides,
});

export const AI_LIST_CALLS: AiListedCall[] = [
  call(0, "2026-11-16T07:38:12.345Z", {
    traceId: "5c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f",
    spanId: "a1b2c3d4e5f60718",
    userId: "user_8f2a",
    conversationId: "chat-41",
    inputTokens: 1520,
    outputTokens: 380,
    cacheReadTokens: 900,
    reasoningTokens: 64,
    costUsd: 0.0078,
    durationMs: 2140,
    firstChunkMs: 590,
  }),
  call(1, "2026-11-16T07:36:51.020Z", {
    service: "worker",
    provider: "openai",
    model: "gpt-5-mini",
    feature: "",
    inputTokens: 640,
    outputTokens: 0,
    costUsd: 0.00016,
    durationMs: 310,
    failed: true,
    errorType: "RateLimitError",
    finishReasons: [],
  }),
  call(2, "2026-11-16T07:34:00.500Z", {
    feature: "summarize-ticket",
    userId: "ada@example.com",
    conversationId: "chat-41",
    inputTokens: 5200,
    outputTokens: 1024,
    costUsd: 0.031,
    durationMs: 7810,
    finishReasons: ["max_tokens"],
  }),
  call(3, "2026-11-16T07:32:00.000Z", {
    provider: "openai",
    model: "acme-support-ft-2026-10",
    userId: "user_8f2a",
    conversationId: "chat-40",
    inputTokens: 480,
    outputTokens: 210,
    costUsd: null,
    durationMs: 1490,
  }),
  call(4, "2026-11-16T07:30:00.000Z", {
    provider: "openai",
    model: "text-embedding-3-small",
    operation: "embeddings",
    feature: "search-index",
    inputTokens: 300,
    outputTokens: 0,
    costUsd: 0.000006,
    durationMs: 120,
    finishReasons: [],
  }),
  call(5, "2026-10-01T03:20:00.000Z", {
    traceId: "6d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a",
    spanId: "b2c3d4e5f6071829",
    userId: "user_8f2a",
    conversationId: "chat-40",
    durationMs: 1800,
  }),
];

/** Each model's price, as the API's price book gives it. */
const PRICES: Record<string, AiCallPrice | null> = {
  "claude-sonnet-4-6": {
    source: "built_in",
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    checked: "2026-11-22",
    model: null,
    effectiveFrom: null,
  },
  "gpt-5-mini": {
    source: "custom",
    rates: { input: 0.2, output: 1.6, cacheRead: null, cacheWrite: null },
    checked: null,
    model: null,
    effectiveFrom: "2026-10-31T16:00:00.000Z",
  },
  "text-embedding-3-small": {
    source: "price_as",
    rates: { input: 0.02, output: 0, cacheRead: null, cacheWrite: null },
    checked: null,
    model: "text-embedding-3-large",
    effectiveFrom: null,
  },
};

export const fakeAiCalls = (): FakeAiCalls => ({
  calls: AI_LIST_CALLS,
  pageSize: 100,
  received: true,
});

/** The calls a query's filters keep, newest first; users hidden without the Users area. */
function filtered(
  calls: readonly AiListedCall[],
  query: URLSearchParams,
  usersVisible: boolean,
  { conversation = true, failed = true } = {},
): AiListedCall[] {
  const environment = query.get("environment") ?? "production";
  const keeps = (value: string, name: string) => {
    const wanted = query.get(name);
    return wanted === null || wanted === value;
  };
  return calls
    .filter(
      (item) =>
        item.environment === environment &&
        keeps(item.service, "service") &&
        keeps(item.provider, "provider") &&
        keeps(item.model, "model") &&
        keeps(item.feature, "feature") &&
        keeps(item.userId ?? "", "user") &&
        (!conversation || keeps(item.conversationId, "conversation")) &&
        (!failed || query.get("status") !== "failed" || item.failed),
    )
    .map((item) => (usersVisible ? item : { ...item, userId: null }));
}

function labelsOf(fake: FakeAiCalls, query: URLSearchParams, usersVisible: boolean) {
  const values = (pick: (item: AiListedCall) => string) =>
    [...new Set(fake.calls.map(pick))].toSorted((a, b) => a.localeCompare(b));
  return {
    ...RANGE,
    environment: query.get("environment") ?? "production",
    environments: ["production", "staging"],
    services: values((item) => item.service),
    filterOptions: {
      services: values((item) => item.service),
      providers: values((item) => item.provider),
      models: values((item) => item.model),
      features: values((item) => item.feature),
    },
    received: fake.received,
    usersHidden: !usersVisible,
  };
}

function listOf(fake: FakeAiCalls, query: URLSearchParams, usersVisible: boolean): AiCallPage {
  const calls = filtered(fake.calls, query, usersVisible);
  const before = query.get("before");
  const start = before === null ? 0 : calls.findIndex((item) => item.id === before) + 1;
  const page = calls.slice(start, start + fake.pageSize);
  const more = start + fake.pageSize < calls.length;
  const failed = calls.filter((item) => item.failed).length;
  if (before !== null) {
    // As the API: a later page is only its calls.
    return {
      ...RANGE,
      environment: query.get("environment") ?? "production",
      environments: null,
      services: null,
      filterOptions: null,
      received: null,
      usersHidden: !usersVisible,
      pageSize: fake.pageSize,
      totals: null,
      calls: page,
      next: more ? (page.at(-1)?.id ?? null) : null,
    };
  }
  return {
    ...labelsOf(fake, query, usersVisible),
    pageSize: fake.pageSize,
    totals: {
      calls: calls.length,
      costUsd: calls.reduce((total, item) => total + (item.costUsd ?? 0), 0),
      failed,
      failedShare: calls.length === 0 ? null : failed / calls.length,
      noPriceCalls: calls.filter((item) => item.costUsd === null).length,
    },
    calls: page,
    next: more ? (page.at(-1)?.id ?? null) : null,
  };
}

function figuresOf(calls: readonly AiListedCall[]) {
  const ordered = calls.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    startedAt: ordered[0]?.at ?? "",
    lastAt: ordered.at(-1)?.at ?? "",
    calls: calls.length,
    inputTokens: calls.reduce((total, item) => total + item.inputTokens, 0),
    outputTokens: calls.reduce((total, item) => total + item.outputTokens, 0),
    costUsd: calls.reduce((total, item) => total + (item.costUsd ?? 0), 0),
    noPriceCalls: calls.filter((item) => item.costUsd === null).length,
    durationMs: calls.reduce((total, item) => total + item.durationMs, 0),
    failed: calls.filter((item) => item.failed).length,
  };
}

function conversationsOf(
  fake: FakeAiCalls,
  query: URLSearchParams,
  usersVisible: boolean,
): AiConversationList {
  const calls = filtered(fake.calls, query, usersVisible, { conversation: false, failed: false });
  const groups = new Map<string, AiListedCall[]>();
  for (const item of calls) {
    if (item.conversationId === "") continue;
    groups.set(item.conversationId, [...(groups.get(item.conversationId) ?? []), item]);
  }
  const rows: AiConversationRow[] = [...groups]
    .map(([conversationId, group]) => ({
      conversationId,
      ...figuresOf(group),
      userId: group.find((item) => item.userId !== null)?.userId ?? null,
      features: [...new Set(group.map((item) => item.feature))].toSorted((a, b) =>
        a.localeCompare(b),
      ),
      models: [...new Set(group.map((item) => item.model))].toSorted((a, b) => a.localeCompare(b)),
    }))
    .filter((row) => query.get("status") !== "failed" || row.failed > 0)
    .toSorted((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return {
    ...labelsOf(fake, query, usersVisible),
    limit: 1000,
    more: false,
    conversations: rows,
  };
}

function conversationOf(
  fake: FakeAiCalls,
  conversationId: string,
  query: URLSearchParams,
  usersVisible: boolean,
): AiConversationDetail {
  const calls = filtered(fake.calls, query, usersVisible, { conversation: false, failed: false })
    .filter((item) => item.conversationId === conversationId)
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    ...RANGE,
    environment: query.get("environment") ?? "production",
    conversationId,
    usersHidden: !usersVisible,
    limit: 500,
    more: false,
    figures: calls.length === 0 ? null : figuresOf(calls),
    calls,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The AI calls list's routes; null for any other path. */
export async function answerAiCalls(
  fake: FakeAiCalls,
  url: URL,
  usersVisible: boolean,
): Promise<Response | null> {
  const path = url.pathname;
  const query = url.searchParams;
  if (query.has("user") && !usersVisible) {
    return json(
      { error: "forbidden", message: "Filtering AI calls by user needs access to the Users area." },
      403,
    );
  }
  if (/^\/api\/projects\/[^/]+\/ai\/call-list$/.test(path)) {
    return fake.list === undefined ? json(listOf(fake, query, usersVisible)) : fake.list(query);
  }
  const one = /^\/api\/projects\/[^/]+\/ai\/calls\/([^/]+)$/.exec(path);
  if (one !== null) {
    const found = fake.calls.find((item) => item.id === decodeURIComponent(one[1] ?? ""));
    if (found === undefined) {
      return json({ error: "no_such_call", message: "No AI call has this ID." }, 404);
    }
    const detail: AiCallDetail = {
      timeZone: RANGE.timeZone,
      usersHidden: !usersVisible,
      traceRetentionDays: 30,
      // The fixtures' "now" is 16 Nov 2026: a call of 1 Oct is past the spans' 30 days.
      traceKept: found.traceId !== "" && Date.parse(found.at) > Date.parse("2026-10-17T00:00:00Z"),
      call: usersVisible ? found : { ...found, userId: null },
      price: PRICES[found.model] ?? null,
    };
    return json(detail);
  }
  if (/^\/api\/projects\/[^/]+\/ai\/conversations$/.test(path)) {
    return json(conversationsOf(fake, query, usersVisible));
  }
  const conversation = /^\/api\/projects\/[^/]+\/ai\/conversations\/([^/]+)$/.exec(path);
  if (conversation !== null) {
    return json(
      conversationOf(fake, decodeURIComponent(conversation[1] ?? ""), query, usersVisible),
    );
  }
  return null;
}
