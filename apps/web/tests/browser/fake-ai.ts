import type {
  AiCall,
  AiCalls,
  AiChart,
  AiFeatureRow,
  AiFigures,
  AiModelRow,
  AiReport,
  AiSeries,
  AiTotals,
} from "../../src/lib/ai-api.ts";

/**
 * The AI page's routes in the fake API (GET /api/projects/:id/ai, /chart,
 * /calls; the API's own tests are apps/api/tests/ai-report.test.ts). The
 * fixtures are one week of a support app's LLM calls: Claude Sonnet for
 * the support chat and ticket summaries, GPT-5 mini for unlabeled calls,
 * an embedding model for the search index, and a fine-tuned model the
 * price table does not know.
 */
export interface FakeAi {
  /** GET …/ai (a promise holds it); `usersVisible` is whether the reader has the Users area. */
  report: (
    query: URLSearchParams,
    usersVisible: boolean,
  ) => AiReport | Response | Promise<AiReport | Response>;
  /** GET …/ai/chart. */
  chart: (query: URLSearchParams) => AiChart | Response | Promise<AiChart | Response>;
  /** GET …/ai/calls. */
  calls: (
    query: URLSearchParams,
    usersVisible: boolean,
  ) => AiCalls | Response | Promise<AiCalls | Response>;
}

const RANGE = {
  timeZone: "Asia/Singapore",
  firstDay: "2026-11-10",
  lastDay: "2026-11-16",
};

const rangeOf = (query: URLSearchParams) => ({
  ...RANGE,
  environment: query.get("environment") ?? "production",
});

/** A breakdown row's figures from what differs, the shares worked out. */
function figures(row: {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd: number;
  failed?: number;
  noPriceCalls?: number;
  p50Ms: number;
  p95Ms: number;
  firstChunkP50Ms: number | null;
  cutOff?: number;
}): AiFigures {
  const cacheReadTokens = row.cacheReadTokens ?? 0;
  const failed = row.failed ?? 0;
  const cutOff = row.cutOff ?? 0;
  return {
    calls: row.calls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: row.costUsd,
    cacheReadShare: row.inputTokens === 0 ? null : cacheReadTokens / row.inputTokens,
    failed,
    failedShare: failed / row.calls,
    noPriceCalls: row.noPriceCalls ?? 0,
    p50Ms: row.p50Ms,
    p95Ms: row.p95Ms,
    firstChunkP50Ms: row.firstChunkP50Ms,
    cutOff,
    cutOffShare: cutOff / row.calls,
  };
}

export const AI_MODELS: AiModelRow[] = [
  {
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    other: false,
    priced: true,
    ...figures({
      calls: 4210,
      inputTokens: 6_315_000,
      outputTokens: 1_263_000,
      cacheReadTokens: 3_157_500,
      costUsd: 29.37,
      failed: 21,
      p50Ms: 1840,
      p95Ms: 6420,
      firstChunkP50Ms: 610,
      cutOff: 34,
    }),
  },
  {
    model: "gpt-5-mini",
    provider: "openai",
    other: false,
    priced: true,
    ...figures({
      calls: 9800,
      inputTokens: 4_900_000,
      outputTokens: 980_000,
      cacheReadTokens: 1_470_000,
      costUsd: 3.27,
      failed: 147,
      p50Ms: 920,
      p95Ms: 2810,
      firstChunkP50Ms: 340,
    }),
  },
  {
    model: "text-embedding-3-small",
    provider: "openai",
    other: false,
    priced: true,
    ...figures({
      calls: 2400,
      inputTokens: 1_200_000,
      outputTokens: 0,
      costUsd: 0.024,
      p50Ms: 120,
      p95Ms: 310,
      firstChunkP50Ms: null,
    }),
  },
  {
    model: "acme-support-ft-2026-10",
    provider: "openai",
    other: false,
    priced: false,
    ...figures({
      calls: 90,
      inputTokens: 45_000,
      outputTokens: 18_000,
      costUsd: 0,
      noPriceCalls: 90,
      p50Ms: 1500,
      p95Ms: 3900,
      firstChunkP50Ms: 420,
    }),
  },
];

export const AI_FEATURES: AiFeatureRow[] = [
  {
    feature: "support-chat",
    other: false,
    ...figures({
      calls: 5100,
      inputTokens: 6_100_000,
      outputTokens: 1_150_000,
      cacheReadTokens: 3_000_000,
      costUsd: 24.8,
      failed: 30,
      noPriceCalls: 90,
      p50Ms: 1760,
      p95Ms: 6100,
      firstChunkP50Ms: 580,
      cutOff: 20,
    }),
  },
  {
    feature: "summarize-ticket",
    other: false,
    ...figures({
      calls: 2000,
      inputTokens: 1_160_000,
      outputTokens: 360_000,
      cacheReadTokens: 157_500,
      costUsd: 4.74,
      failed: 8,
      p50Ms: 2100,
      p95Ms: 7000,
      firstChunkP50Ms: 650,
      cutOff: 14,
    }),
  },
  {
    feature: "",
    other: false,
    ...figures({
      calls: 7000,
      inputTokens: 4_000_000,
      outputTokens: 751_000,
      cacheReadTokens: 1_470_000,
      costUsd: 3.1,
      failed: 130,
      p50Ms: 900,
      p95Ms: 2700,
      firstChunkP50Ms: 330,
    }),
  },
  {
    feature: "search-index",
    other: false,
    ...figures({
      calls: 2400,
      inputTokens: 1_200_000,
      outputTokens: 0,
      costUsd: 0.024,
      p50Ms: 120,
      p95Ms: 310,
      firstChunkP50Ms: null,
    }),
  },
];

/** This week's totals: 16,500 calls costing an estimated $32.66, 90 of them without a price. */
export const AI_TOTALS: AiTotals = {
  calls: 16_500,
  inputTokens: 12_460_000,
  outputTokens: 2_261_000,
  cacheReadTokens: 4_627_500,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 32.664,
  cacheReadShare: 4_627_500 / 12_460_000,
  p95Ms: 5120,
  failed: 168,
  failedShare: 168 / 16_500,
  noPriceCalls: 90,
  noPriceModels: ["acme-support-ft-2026-10"],
};

/** The week before: fewer calls, all priced. */
export const AI_PREVIOUS: AiTotals = {
  calls: 12_000,
  inputTokens: 9_100_000,
  outputTokens: 1_700_000,
  cacheReadTokens: 2_730_000,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 24.1,
  cacheReadShare: 0.3,
  p95Ms: 4800,
  failed: 36,
  failedShare: 0.003,
  noPriceCalls: 0,
  noPriceModels: [],
};

export const AI_USERS: NonNullable<AiReport["users"]> = [
  {
    userId: "user_8f2a",
    calls: 420,
    inputTokens: 630_000,
    outputTokens: 126_000,
    costUsd: 2.94,
    failed: 2,
    noPriceCalls: 0,
  },
  {
    userId: "ada@example.com",
    calls: 310,
    inputTokens: 410_000,
    outputTokens: 98_000,
    costUsd: 1.71,
    failed: 0,
    noPriceCalls: 4,
  },
];

const NO_TOTALS: AiTotals = {
  ...AI_PREVIOUS,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  cacheReadShare: null,
  p95Ms: null,
  failed: 0,
  failedShare: null,
};

/** The user "ada" (the users fakes' one user): her calls, filtered with `user=ada`. */
export const ADA_AI_TOTALS: AiTotals = {
  ...AI_PREVIOUS,
  calls: 310,
  inputTokens: 410_000,
  outputTokens: 98_000,
  cacheReadTokens: 0,
  costUsd: 1.71,
  cacheReadShare: 0,
  p95Ms: 4980,
  failed: 6,
  failedShare: 6 / 310,
  noPriceCalls: 4,
  noPriceModels: ["acme-support-ft-2026-10"],
};

const ADA_MODELS: AiModelRow[] = [
  {
    ...AI_MODELS[0],
    ...figures({
      calls: 210,
      inputTokens: 300_000,
      outputTokens: 80_000,
      costUsd: 1.52,
      failed: 4,
      p50Ms: 1800,
      p95Ms: 6000,
      firstChunkP50Ms: 600,
    }),
  },
  {
    ...AI_MODELS[1],
    ...figures({
      calls: 96,
      inputTokens: 100_000,
      outputTokens: 17_000,
      costUsd: 0.19,
      failed: 2,
      p50Ms: 900,
      p95Ms: 2700,
      firstChunkP50Ms: 330,
    }),
  },
  {
    ...AI_MODELS[3],
    ...figures({
      calls: 4,
      inputTokens: 10_000,
      outputTokens: 1000,
      costUsd: 0,
      noPriceCalls: 4,
      p50Ms: 1200,
      p95Ms: 1500,
      firstChunkP50Ms: null,
    }),
  },
];

const ADA_FEATURES: AiFeatureRow[] = (
  [
    ["support-chat", 180, 1.31],
    ["summarize-ticket", 30, 0.21],
    ["", 96, 0.19],
    ["search-index", 4, 0],
  ] as const
).map(([feature, calls, costUsd]) => ({
  feature,
  other: false,
  ...figures({
    calls,
    inputTokens: calls * 1300,
    outputTokens: calls * 300,
    costUsd,
    p50Ms: 1500,
    p95Ms: 4980,
    firstChunkP50Ms: null,
  }),
}));

/** One user's report (`user=`): ada's calls, or none for anyone else. */
function userReport(report: AiReport, userId: string): AiReport {
  const ada = userId === "ada";
  const totals = ada ? ADA_AI_TOTALS : NO_TOTALS;
  return {
    ...report,
    totals,
    previous: { ...report.previous, totals: NO_TOTALS },
    models: ada ? ADA_MODELS : [],
    features: ada ? ADA_FEATURES : [],
    users: report.users === null ? null : ada ? [{ ...AI_USERS[1], userId }] : [],
    failures: ada
      ? [{ errorType: "RateLimitError", calls: 6, lastAt: "2026-11-16T07:41:00.000Z" }]
      : [],
  };
}

/** The week's report, as the owner (with the Users area) reads it; `user=` filters by one user. */
export function fakeAiReport(query: URLSearchParams, usersVisible: boolean): AiReport {
  const userId = query.get("user");
  const report = weekReport(query, usersVisible);
  return userId === null ? report : userReport(report, userId);
}

function weekReport(query: URLSearchParams, usersVisible: boolean): AiReport {
  return {
    ...rangeOf(query),
    environments: ["production", "staging"],
    services: ["support-api", "worker"],
    filterOptions: {
      services: ["support-api", "worker"],
      providers: ["anthropic", "openai"],
      models: AI_MODELS.map((row) => row.model),
      features: AI_FEATURES.map((row) => row.feature),
    },
    received: true,
    totals: AI_TOTALS,
    previous: { firstDay: "2026-11-03", lastDay: "2026-11-09", until: null, totals: AI_PREVIOUS },
    models: AI_MODELS,
    features: AI_FEATURES,
    users: usersVisible ? AI_USERS : null,
    usersHidden: !usersVisible,
    failures: [
      { errorType: "RateLimitError", calls: 120, lastAt: "2026-11-16T07:41:00.000Z" },
      { errorType: "APITimeoutError", calls: 40, lastAt: "2026-11-16T06:12:00.000Z" },
      { errorType: "", calls: 8, lastAt: "2026-11-15T23:05:00.000Z" },
    ],
    limits: { models: 2000, features: 500, users: 50 },
  };
}

/** A project that has never sent an AI call. */
export function noAiCalls(query: URLSearchParams, usersVisible: boolean): AiReport {
  return {
    ...fakeAiReport(query, usersVisible),
    filterOptions: { services: [], providers: [], models: [], features: [] },
    received: false,
    totals: NO_TOTALS,
    previous: { firstDay: "2026-11-03", lastDay: "2026-11-09", until: null, totals: NO_TOTALS },
    models: [],
    features: [],
    users: usersVisible ? [] : null,
    failures: [],
  };
}

/** The week's seven days, from midnight in Singapore. */
const DAY_STARTS = Array.from({ length: 7 }, (_, day) =>
  new Date(Date.UTC(2026, 10, 9, 16) + day * 86_400_000).toISOString(),
);
/** Each day's share of the week. */
const WEIGHTS = [0.1, 0.12, 0.14, 0.15, 0.16, 0.17, 0.16];

/** A line over the week: the totals spread by day, the 95th percentile the same each day. */
function seriesOf(
  row: Pick<AiFigures, "costUsd" | "inputTokens" | "outputTokens" | "calls" | "p95Ms">,
): AiSeries {
  return {
    costUsd: WEIGHTS.map((weight) => row.costUsd * weight),
    tokens: WEIGHTS.map((weight) => Math.round((row.inputTokens + row.outputTokens) * weight)),
    calls: WEIGHTS.map((weight) => Math.round(row.calls * weight)),
    p95Ms: WEIGHTS.map(() => row.p95Ms),
  };
}

/** The week's chart by day, split by model (the default) or feature. */
export function fakeAiChart(query: URLSearchParams): AiChart {
  const split = query.get("split") === "feature" ? "feature" : "model";
  const rows: { key: string; figures: AiFigures }[] =
    split === "model"
      ? AI_MODELS.map((row) => ({ key: row.model, figures: row }))
      : AI_FEATURES.map((row) => ({ key: row.feature, figures: row }));
  return {
    ...rangeOf(query),
    start: DAY_STARTS[0] ?? "",
    bucketStarts: DAY_STARTS,
    stepSeconds: 86_400,
    buckets: 7,
    split,
    total: seriesOf(AI_TOTALS),
    series: rows.map((row) => ({ key: row.key, other: false, ...seriesOf(row.figures) })),
  };
}

export const AI_CALLS: AiCall[] = [
  {
    traceId: "5c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f",
    spanId: "a1b2c3d4e5f60718",
    startNs: "1763278692345000000",
    at: "2026-11-16T07:38:12.345Z",
    service: "support-api",
    release: "2.14.0",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    operation: "chat",
    feature: "support-chat",
    userId: "user_8f2a",
    inputTokens: 1520,
    outputTokens: 380,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.0078,
    durationMs: 2140,
    firstChunkMs: 590,
    failed: false,
    errorType: "",
    finishReasons: ["end_turn"],
  },
  {
    traceId: "6d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a",
    spanId: "b2c3d4e5f6071829",
    startNs: "1763278611020000000",
    at: "2026-11-16T07:36:51.020Z",
    service: "worker",
    release: "2.14.0",
    provider: "openai",
    model: "gpt-5-mini",
    operation: "chat",
    feature: "",
    userId: null,
    inputTokens: 640,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.00016,
    durationMs: 310,
    firstChunkMs: null,
    failed: true,
    errorType: "RateLimitError",
    finishReasons: [],
  },
  {
    traceId: "7e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b",
    spanId: "c3d4e5f607182930",
    startNs: "1763278440500000000",
    at: "2026-11-16T07:34:00.500Z",
    service: "support-api",
    release: "2.14.0",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    operation: "chat",
    feature: "summarize-ticket",
    userId: "ada@example.com",
    inputTokens: 5200,
    outputTokens: 1024,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.031,
    durationMs: 7810,
    firstChunkMs: 702,
    failed: false,
    errorType: "",
    finishReasons: ["max_tokens"],
  },
  {
    traceId: "8f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c",
    spanId: "d4e5f60718293a4b",
    startNs: "1763278320000000000",
    at: "2026-11-16T07:32:00.000Z",
    service: "support-api",
    release: "2.14.0",
    provider: "openai",
    model: "acme-support-ft-2026-10",
    operation: "chat",
    feature: "support-chat",
    userId: "user_8f2a",
    inputTokens: 480,
    outputTokens: 210,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    durationMs: 1490,
    firstChunkMs: 418,
    failed: false,
    errorType: "",
    finishReasons: ["stop"],
  },
];

/** The latest calls; without the Users area, none names its user. */
export function fakeAiCalls(query: URLSearchParams, usersVisible: boolean): AiCalls {
  return {
    ...rangeOf(query),
    limit: 50,
    usersHidden: !usersVisible,
    calls: usersVisible ? AI_CALLS : AI_CALLS.map((call) => ({ ...call, userId: null })),
  };
}

export const fakeAi = (): FakeAi => ({
  report: fakeAiReport,
  chart: fakeAiChart,
  calls: fakeAiCalls,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

/** An answer as a response: a Response stands for an error. */
async function answered(result: unknown): Promise<Response> {
  const value: unknown = await result;
  return value instanceof Response ? value : json(value);
}

/** The AI routes; null for any other path. */
export async function answerAi(
  ai: FakeAi,
  url: URL,
  usersVisible: boolean,
): Promise<Response | null> {
  const path = url.pathname;
  if (/^\/api\/projects\/[^/]+\/ai$/.test(path)) {
    return answered(ai.report(url.searchParams, usersVisible));
  }
  if (/^\/api\/projects\/[^/]+\/ai\/chart$/.test(path)) {
    return answered(ai.chart(url.searchParams));
  }
  if (/^\/api\/projects\/[^/]+\/ai\/calls$/.test(path)) {
    return answered(ai.calls(url.searchParams, usersVisible));
  }
  return null;
}
