import type { AiModel, AiModelList, Rates } from "../../src/lib/ai-models-api.ts";

/**
 * Settings → AI models in the fake API (GET /api/settings/ai-models and
 * its three changes; the API's own tests are
 * apps/api/tests/ai-models.test.ts), for the owner and admins, changed
 * as the API would. The prices are test fixtures, not the bundled table's.
 */
export interface FakeAiModels {
  /** GET /api/settings/ai-models; a Response stands for an error. */
  list: AiModelList | Response;
  /** Each change's path and body, in order. */
  changes: { path: string; body: unknown }[];
  /** Answers a change with this instead, once (an API refusal). */
  refuseNext: Response | null;
  /** While set, the list waits for it: a test holds the read after a change back. */
  holdList: Promise<void> | null;
}

const SONNET: Rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const MINI: Rates = { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: null };

const builtIn = (label: string, rates: Rates, notes: string | null = null) => ({
  label,
  checked: "2026-11-22",
  source: "https://pricing.example.com/models",
  notes,
  rates,
});

const model = (fields: Partial<AiModel> & Pick<AiModel, "model" | "provider">): AiModel => ({
  label: null,
  calls: 0,
  price: null,
  source: null,
  current: null,
  covers: null,
  builtIn: null,
  prices: [],
  priceAs: null,
  ...fields,
});

/** A long model ID, cut off in the table. */
export const LONG_MODEL = "us.anthropic.claude-sonnet-4-6-acme-regional-inference-profile-2026-11";

export const AI_MODELS: AiModelList = {
  now: "2026-11-20T04:00:00.000Z",
  callsDays: 30,
  callsCounted: true,
  limits: { maxPrice: 10_000, decimals: 6 },
  models: [
    model({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      label: "Claude Sonnet 4.6",
      calls: 12_000,
      price: SONNET,
      source: "built_in",
      builtIn: builtIn(
        "Claude Sonnet 4.6",
        SONNET,
        "Prompts over 200K input tokens: 2x input, 1.5x output.",
      ),
      covers: { ids: ["claude-sonnet-4-6"], prefixes: [] },
    }),
    model({
      model: "gpt-5-mini",
      provider: "openai",
      label: "GPT-5 mini",
      calls: 4500,
      price: MINI,
      source: "built_in",
      builtIn: builtIn("GPT-5 mini", MINI),
      covers: { ids: ["gpt-5-mini", "gpt-5-mini-2025-08-07"], prefixes: [] },
      // A price change already set, from 1 December.
      prices: [
        {
          effectiveFrom: "2026-11-30T16:00:00.000Z",
          rates: { input: 0.2, output: 1.6, cacheRead: null, cacheWrite: null },
          updatedAt: "2026-11-19T09:00:00.000Z",
          updatedBy: "Test Owner",
        },
      ],
    }),
    model({
      model: "llama-3.3-70b",
      provider: "ollama",
      calls: 800,
      price: { input: 0, output: 0, cacheRead: null, cacheWrite: null },
      source: "custom",
      current: {
        model: "llama-3.3-70b",
        effectiveFrom: null,
        updatedAt: "2026-11-18T02:00:00.000Z",
        updatedBy: "Test Owner",
      },
      prices: [
        {
          effectiveFrom: null,
          rates: { input: 0, output: 0, cacheRead: null, cacheWrite: null },
          updatedAt: "2026-11-18T02:00:00.000Z",
          updatedBy: "Test Owner",
        },
      ],
    }),
    model({
      model: "claude-sonnet-eu-2026-10",
      provider: "anthropic",
      calls: 300,
      price: SONNET,
      source: "price_as",
      priceAs: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        updatedAt: "2026-11-18T03:00:00.000Z",
        updatedBy: null,
      },
    }),
    model({ model: "acme-support-ft-2026-10", provider: "openai", calls: 90 }),
    model({ model: LONG_MODEL, provider: "aws.bedrock", calls: 2 }),
  ],
};

/** The fixture with `count` more built-in models after it, never called, for paging. */
export function manyAiModels(count: number): AiModelList {
  const list = structuredClone(AI_MODELS);
  for (let index = 1; index <= count; index += 1) {
    const name = `fixture-model-${String(index).padStart(3, "0")}`;
    const rates: Rates = { input: 1, output: 2, cacheRead: null, cacheWrite: null };
    list.models.push(
      model({
        model: name,
        provider: "fixture",
        label: `Fixture ${index}`,
        price: rates,
        source: "built_in",
        builtIn: builtIn(`Fixture ${index}`, rates),
        covers: { ids: [name], prefixes: [] },
      }),
    );
  }
  return list;
}

export function fakeAiModels(overrides: Partial<FakeAiModels> = {}): FakeAiModels {
  return {
    list: structuredClone(AI_MODELS),
    changes: [],
    refuseNext: null,
    holdList: null,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FORBIDDEN = {
  error: "forbidden",
  message: "You don't have access to this. Ask the instance's owner or an admin if you need it.",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const rate = (value: unknown) => (typeof value === "number" ? value : null);

/** A model's price now and where it comes from, as the API works it out. */
function priced(row: AiModel, list: AiModelList): AiModel {
  const now = Date.parse(list.now);
  const own = row.prices.filter(
    (price) => price.effectiveFrom === null || Date.parse(price.effectiveFrom) <= now,
  );
  const current = own.at(-1);
  if (current !== undefined) {
    return {
      ...row,
      price: current.rates,
      source: "custom",
      current: {
        model: row.model,
        effectiveFrom: current.effectiveFrom,
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
      },
    };
  }
  if (row.builtIn !== null) {
    return { ...row, price: row.builtIn.rates, source: "built_in", current: null };
  }
  const target = list.models.find((item) => item.model === row.priceAs?.model);
  if (target?.price !== null && target?.price !== undefined) {
    return { ...row, price: target.price, source: "price_as", current: null };
  }
  return { ...row, price: null, source: null, current: null };
}

/** Answers an AI models route, or null when the path is not one. */
export function answerAiModels(
  fake: FakeAiModels,
  url: URL,
  init: RequestInit | undefined,
  role: string,
): Response | Promise<Response> | null {
  const path = url.pathname;
  if (!path.startsWith("/api/settings/ai-models")) return null;
  if (role === "member") return json(FORBIDDEN, 403);
  const method = init?.method ?? "GET";
  if (path === "/api/settings/ai-models" && method === "GET") {
    const answer = () => (fake.list instanceof Response ? fake.list.clone() : json(fake.list));
    return fake.holdList === null ? answer() : fake.holdList.then(answer);
  }
  const body: unknown =
    typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : {};
  fake.changes.push({ path, body });
  if (fake.refuseNext !== null) {
    const refusal = fake.refuseNext;
    fake.refuseNext = null;
    return refusal;
  }
  if (fake.list instanceof Response || !isRecord(body)) return json({ error: "bad" }, 400);
  const list = fake.list;
  const name = text(body.model);
  const existing = list.models.find((item) => item.model === name);
  const row = existing ?? model({ model: name, provider: text(body.provider) });
  let next: AiModel;
  if (path === "/api/settings/ai-models/price") {
    const rates: Rates = {
      input: Number(body.input),
      output: Number(body.output),
      cacheRead: rate(body.cacheRead),
      cacheWrite: rate(body.cacheWrite),
    };
    const day = typeof body.effectiveFrom === "string" ? body.effectiveFrom : null;
    const changed = { rates, updatedAt: list.now, updatedBy: "Test Owner" };
    if (day === null) {
      next = { ...row, prices: [{ effectiveFrom: null, ...changed }], priceAs: null };
    } else {
      // Midnight in Asia/Singapore, the fake instance's timezone.
      const from = new Date(Date.parse(`${day}T00:00:00+08:00`)).toISOString();
      next = {
        ...row,
        prices: [
          ...row.prices.filter((price) => price.effectiveFrom !== from),
          { effectiveFrom: from, ...changed },
        ].toSorted((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? "")),
      };
    }
  } else if (path === "/api/settings/ai-models/price-as") {
    const target = isRecord(body.priceAs) ? body.priceAs : {};
    next = {
      ...row,
      prices: row.prices.filter((price) => price.effectiveFrom !== null),
      priceAs: {
        provider: text(target.provider),
        model: text(target.model),
        updatedAt: list.now,
        updatedBy: "Test Owner",
      },
    };
  } else if (path === "/api/settings/ai-models/reset") {
    next = { ...row, prices: [], priceAs: null };
  } else {
    return json({ error: "not_found", message: `No fake answer for ${path}` }, 404);
  }
  const models =
    existing === undefined
      ? [...list.models, next]
      : list.models.map((item) => (item.model === name ? next : item));
  const kept = models.filter(
    (item) =>
      (item.calls ?? 0) > 0 ||
      item.builtIn !== null ||
      item.prices.length > 0 ||
      item.priceAs !== null,
  );
  const withList = { ...list, models: kept };
  fake.list = { ...withList, models: kept.map((item) => priced(item, withList)) };
  return json({ model: name });
}
