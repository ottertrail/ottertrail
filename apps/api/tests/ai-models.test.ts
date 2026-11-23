import { randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { readPriceBook } from "../src/ai/custom-prices.ts";
import {
  costOf,
  type CustomPrice,
  type ModelPrice,
  priceAt,
  priceBookOf,
  priceOf,
  pricedColumns,
  type PriceBook,
  type Rates,
} from "../src/ai/prices.ts";
import { aiWindow } from "../src/ai/report.ts";
import { aiWindowAt } from "../src/alerts/ai-rules.ts";
import type { AiCostSettings } from "../src/alerts/kinds.ts";
import { evaluateTelemetryRule, telemetryRules } from "../src/alerts/telemetry-rules.ts";
import { QueryParams, queryRows } from "../src/clickhouse/query.ts";
import { nanosText } from "../src/telemetry/normalize.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject, setInstanceTimeZone } from "./helpers/projects.ts";

/**
 * Compare ClickHouse and JavaScript pricing, including changes to retained alert hours.
 * See docs/ai-usage.md, "Prices", ai/custom-prices.ts, and ai/model-routes.ts.
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";

const DAY = 86_400_000;
const MINUTE = 60_000;
const SONNET = "claude-sonnet-4-6";
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const dayText = (moment: Date) => moment.toISOString().slice(0, 10);
const midnight = (moment: Date) => new Date(`${dayText(moment)}T00:00:00Z`);

beforeAll(async () => {
  dashboard = await signedInDashboard({
    aiModels: { changeLimit: { capacity: 1000, refillPerSecond: 1000 } },
  });
});

afterAll(async () => {
  await dashboard?.close();
});

beforeEach(async () => {
  await dashboard.db.deleteFrom("ai_model_prices").execute();
  await dashboard.db.deleteFrom("alert_rules").execute();
  projectId = (await insertProject(dashboard.db, { name: `Assistant ${hex(3)}` })).id;
});

const send = (method: "PUT" | "POST", url: string, payload: object, cookie = dashboard.cookie) =>
  dashboard.app.inject({
    method,
    url: `/api${url}`,
    headers: { cookie, origin: PUBLIC_URL },
    payload,
  });

const priceBody = (model: string, rates: Partial<Rates>, effectiveFrom: string | null = null) => ({
  provider: "anthropic",
  model,
  effectiveFrom,
  input: 1,
  output: 1,
  cacheRead: null,
  cacheWrite: null,
  ...rates,
});

const setPrice = async (
  model: string,
  rates: Partial<Rates>,
  effectiveFrom: string | null = null,
) => {
  const response = await send(
    "PUT",
    "/settings/ai-models/price",
    priceBody(model, rates, effectiveFrom),
  );
  expect(response.statusCode).toBe(200);
};

/** Calls straight into ai_calls, each a million input and a million output tokens. */
async function insertCalls(calls: { model: string; at: Date }[], project = projectId) {
  const ids = calls.map(() => hex(24));
  await dashboard.reader.client.insert({
    table: "ai_calls",
    values: calls.map((call, index) => ({
      project_id: project,
      timestamp: nanosText(BigInt(call.at.getTime()) * 1_000_000n),
      id: ids[index],
      model: call.model,
      provider: "anthropic",
      environment: "production",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })),
    format: "JSONEachRow",
  });
  return ids;
}

/** Each call's cost as the queries work it out, by ID; null without a price. */
async function costs(ids: readonly string[]): Promise<(number | null)[]> {
  const params = new QueryParams();
  const book = await readPriceBook(dashboard.db);
  const rows = await queryRows<{ id: string; cost: number; priced: number | boolean }>(
    dashboard.reader,
    `SELECT id, cost, priced FROM (SELECT *, ${pricedColumns(params, book)} FROM ai_calls
     WHERE project_id = ${params.add(projectId, "UUID")})`,
    params,
  );
  const byId = costsById(rows);
  return ids.map((id) => byId.get(id) ?? null);
}

/** Each row's cost by its ID; null without a price. */
function costsById(rows: { id: string; cost: number; priced: number | boolean }[]) {
  return new Map(rows.map((row) => [row.id, Number(row.priced) === 1 ? row.cost : null]));
}

/** A million input and a million output tokens at a price. */
const million = (rates: Rates) =>
  costOf(rates, { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
const sonnet = priceOf(SONNET) as ModelPrice;
const bedrockSonnet = priceOf("us.anthropic.claude-sonnet-4-6") as ModelPrice;

/** What priceAt says a call costs: null without a price. */
function expectedCost(book: PriceBook, call: { model: string; at: Date }): number | null {
  const price = priceAt(book, call.model, call.at);
  return price === null ? null : million(price.rates);
}

/** Calls of the kept-hours test: Sonnet and a model without a price, in turn. */
const alternating = (count: number, start: number) =>
  Array.from({ length: count }, (_, index) => ({
    model: index % 2 === 0 ? SONNET : "local-llama",
    at: new Date(start + index * 53 * MINUTE),
  }));

/** A change's status and its error code (Fastify's own for a schema's refusal). */
async function refusal(method: "PUT" | "POST", url: string, payload: object) {
  const response = await send(method, url, payload);
  const body = response.json<{ error?: string; code?: string }>();
  return [response.statusCode, body.code ?? body.error];
}

const priceAs = (model: string, target: string) =>
  refusal("PUT", "/settings/ai-models/price-as", {
    provider: "x",
    model,
    priceAs: { provider: "x", model: target },
  });

/** `days` days before today's midnight, UTC. */
const daysAgo = (days: number) => new Date(midnight(new Date()).getTime() - days * DAY);
const inputRates = (input: number): Rates => ({
  input,
  output: 0,
  cacheRead: null,
  cacheWrite: null,
});
/** A custom row with prices, as the price book takes it. */
const row = (model: string, start: Date | null, input: number): CustomPrice => ({
  provider: "x",
  model,
  effectiveFrom: start,
  rates: inputRates(input),
  priceAs: null,
});
/** A custom row pricing `model` as `target`. */
const asRow = (model: string, target: string): CustomPrice => ({
  provider: "x",
  model,
  effectiveFrom: null,
  rates: null,
  priceAs: { provider: "x", model: target },
});

/** Refusals of the price route. */
const putPrice = (body: object) => refusal("PUT", "/settings/ai-models/price", body);

const COST_SETTINGS: AiCostSettings = {
  environment: "production",
  feature: null,
  model: null,
  costWindow: "month",
  thresholdUsd: 1_000_000_000,
};

async function evaluate(ruleId: string, at: Date) {
  const rules = await telemetryRules(dashboard.db, projectId);
  const rule = rules.find((item) => item.id === ruleId);
  return evaluateTelemetryRule(
    { db: dashboard.db, publicUrl: PUBLIC_URL },
    dashboard.reader,
    rule as never,
    at,
  );
}

/** The rule's window read whole from ClickHouse, at the prices of now. */
async function fullScan(at: Date) {
  const window = await aiWindowAt(dashboard.db, COST_SETTINGS, at, MINUTE);
  return aiWindow(
    dashboard.reader,
    {
      projectId,
      environment: "production",
      prices: await readPriceBook(dashboard.db),
      ...window,
    },
    {},
  );
}

const keptHours = async (ruleId: string) =>
  (
    await dashboard.db
      .selectFrom("ai_cost_hours")
      .select("hour")
      .where("rule_id", "=", ruleId)
      .execute()
  ).length;

describe("read-time cost with the instance's prices", () => {
  const now = Date.now();
  const before = new Date(now - 3 * DAY);
  const after = new Date(now - DAY);
  const from = dayText(new Date(now - 2 * DAY));

  test("for all calls, then from a day on: calls before the day keep the earlier price", async () => {
    const ids = await insertCalls([
      { model: "Local-Llama", at: before },
      { model: "local-llama", at: after },
      { model: SONNET, at: before },
      { model: SONNET, at: after },
    ]);
    expect(await costs(ids)).toEqual([null, null, million(sonnet), million(sonnet)]);

    await setPrice("Local-Llama", { input: 0, output: 0 });
    await setPrice("local-llama", { input: 2, output: 3 }, from);
    await setPrice(SONNET, { input: 1, output: 2 }, from);
    expect(await costs(ids)).toEqual([0, 5, million(sonnet), 3]);

    // For all calls again: a correction replaces the dated price too.
    await setPrice("local-llama", { input: 0.5, output: 0.25 });
    expect(await costs(ids)).toEqual([0.75, 0.75, million(sonnet), 3]);
  });

  test("price as: the target's price at the call's time; reset goes back to none", async () => {
    const ids = await insertCalls([
      { model: "sonnet-snapshot-x", at: before },
      { model: "sonnet-snapshot-x", at: after },
    ]);
    const asSonnet = await send("PUT", "/settings/ai-models/price-as", {
      provider: "anthropic",
      model: "sonnet-snapshot-x",
      priceAs: { provider: "anthropic", model: SONNET },
    });
    expect(asSonnet.statusCode).toBe(200);
    expect(await costs(ids)).toEqual([million(sonnet), million(sonnet)]);

    await setPrice(SONNET, { input: 1, output: 2 }, from);
    expect(await costs(ids)).toEqual([million(sonnet), 3]);
    // The model's own dated price wins over its price as, from its day.
    await setPrice("sonnet-snapshot-x", { input: 4, output: 4 }, from);
    expect(await costs(ids)).toEqual([million(sonnet), 8]);

    const reset = await send("POST", "/settings/ai-models/reset", { model: "Sonnet-Snapshot-X" });
    expect(reset.json()).toEqual({ model: "sonnet-snapshot-x" });
    expect(await costs(ids)).toEqual([null, null]);
    await send("POST", "/settings/ai-models/reset", { model: SONNET });
    expect(await costs(ids)).toEqual([null, null]);
    expect(await dashboard.db.selectFrom("ai_model_prices").select("id").execute()).toEqual([]);
  });

  test("a price on a built-in model covers its other IDs; days start in the instance's timezone", async () => {
    await setInstanceTimeZone(dashboard.db, "Asia/Singapore");
    // Midnight of the day before yesterday in Singapore, and a millisecond before.
    const day = dayText(new Date(now - 2 * DAY));
    const start = new Date(Date.parse(`${day}T00:00:00+08:00`));
    const ids = await insertCalls([
      { model: "gpt-4o-2024-08-06", at: new Date(start.getTime() - 1) },
      { model: "gpt-4o-2024-08-06", at: start },
      { model: "GPT-4o", at: start },
      { model: "gpt-4o-2024-11-20", at: start },
    ]);
    const response = await send("PUT", "/settings/ai-models/price", {
      ...priceBody("gpt-4o", { input: 1, output: 1 }, day),
      provider: "openai",
    });
    expect(response.statusCode).toBe(200);
    await setInstanceTimeZone(dashboard.db, "UTC");
    const gpt4o = million(priceOf("gpt-4o") as ModelPrice);
    expect(await costs(ids)).toEqual([gpt4o, 2, 2, 2]);
    const book = await readPriceBook(dashboard.db);
    expect(priceAt(book, "gpt-4o-2024-08-06", start)?.source).toBe("custom");
    const list = await dashboard.app.inject({
      method: "GET",
      url: "/api/settings/ai-models",
      headers: { cookie: dashboard.cookie },
    });
    const models = list.json<{ models: { model: string }[] }>().models;
    expect(models.find((item) => item.model === "gpt-4o")).toMatchObject({
      covers: { ids: ["gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20"], prefixes: [] },
      current: { model: "gpt-4o", updatedBy: "Ada Owner" },
    });
  });

  test("ClickHouse works out what priceAt does, one level of price as only", async () => {
    const custom = [
      row("a", null, 1),
      row("a", daysAgo(4), 2),
      row("a", daysAgo(2), 3),
      row("b", daysAgo(3), 5),
      asRow("c", "a"),
      asRow("d", "c"),
      asRow("e", SONNET),
      row(SONNET, daysAgo(3), 7),
      // On one ID of GPT-4o's entry: covers every ID of it, below their own rows.
      row("gpt-4o-2024-08-06", daysAgo(3), 11),
      row("gpt-4o-2024-11-20", daysAgo(2), 13),
    ];
    const book = priceBookOf(custom);
    const calls = ["a", "b", "c", "d", "e", SONNET, "us.anthropic.claude-sonnet-4-6"].flatMap(
      (model) =>
        [5, 3.5, 2.5, 1].map((days) => ({ model, at: new Date(daysAgo(days).getTime() + MINUTE) })),
    );
    const ids = await insertCalls(calls);
    const params = new QueryParams();
    const rows = await queryRows<{ id: string; cost: number; priced: number | boolean }>(
      dashboard.reader,
      `SELECT id, cost, priced FROM (SELECT *, ${pricedColumns(params, book)} FROM ai_calls
       WHERE project_id = ${params.add(projectId, "UUID")})`,
      params,
    );
    const byId = costsById(rows);
    const expected = calls.map((call) => expectedCost(book, call));
    expect(ids.map((id) => byId.get(id))).toEqual(expected);
    const s = million(sonnet);
    const bedrock = million(bedrockSonnet);
    expect(expected).toEqual([
      1,
      2,
      2,
      3,
      null,
      null,
      5,
      5,
      1,
      2,
      2,
      3,
      null,
      null,
      null,
      null,
      s,
      s,
      7,
      7,
      s,
      s,
      7,
      7,
      bedrock,
      bedrock,
      bedrock,
      bedrock,
    ]);
    expect(priceAt(book, "e", daysAgo(1))?.source).toBe("price_as");

    // Exactly at a start, and a millisecond before; GPT-4o's IDs through its entry's rows.
    const edges = [
      { model: "a", at: daysAgo(2) },
      { model: "a", at: new Date(daysAgo(2).getTime() - 1) },
      ...["gpt-4o", "GPT-4o-2024-08-06", "gpt-4o-2024-11-20"].flatMap((model) =>
        [3.5, 3, 2.5, 2].map((days) => ({ model, at: daysAgo(days) })),
      ),
    ];
    const edgeIds = await insertCalls(edges);
    const edgeParams = new QueryParams();
    const edgeRows = costsById(
      await queryRows<{ id: string; cost: number; priced: number | boolean }>(
        dashboard.reader,
        `SELECT id, cost, priced FROM (SELECT *, ${pricedColumns(edgeParams, book)} FROM ai_calls
         WHERE project_id = ${edgeParams.add(projectId, "UUID")})`,
        edgeParams,
      ),
    );
    const edgeExpected = edges.map((call) => expectedCost(book, call));
    expect(edgeIds.map((id) => edgeRows.get(id))).toEqual(edgeExpected);
    const gpt4o = million(priceOf("gpt-4o") as ModelPrice);
    expect(edgeExpected).toEqual([
      3,
      2,
      // gpt-4o: the entry's rows, the latest of the two from 2 days ago.
      gpt4o,
      11,
      11,
      13,
      // The 08-06 snapshot's own row wins over the entry's later one.
      gpt4o,
      11,
      11,
      11,
      gpt4o,
      11,
      11,
      13,
    ]);
    expect(priceAt(book, "gpt-4o", daysAgo(1))?.source).toBe("custom");
    expect(priceAt(book, "a", daysAgo(1))?.source).toBe("custom");
    expect(priceAt(book, "us.anthropic.claude-sonnet-4-6", daysAgo(1))?.source).toBe("built_in");
  });
});

describe("AI cost rules' kept hours", () => {
  test("a price change clears them, and the next evaluation adds them up at the new price", async () => {
    const start = Date.parse("2026-10-01T00:00:00Z");
    await insertCalls(alternating(40, start));
    const rule = await dashboard.db
      .insertInto("alert_rules")
      .values({
        project_id: projectId,
        name: "Month",
        kind: "ai_cost",
        settings: JSON.stringify(COST_SETTINGS),
        channel_ids: [],
        active_since: new Date(start),
        created_at: new Date(start),
        updated_at: new Date(start),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const at = new Date("2026-10-02T12:30:00Z");
    const first = await evaluate(rule.id, at);
    expect(first.reading).toMatchObject({
      value: expect.closeTo((await fullScan(at)).costUsd, 9),
      noPriceCalls: 20,
    });
    expect(await keptHours(rule.id)).toBeGreaterThan(20);

    // Marked stale, not deleted: an evaluation running meanwhile still sums what it kept.
    const kept = await keptHours(rule.id);
    await setPrice("local-llama", { input: 1, output: 1 });
    expect(await keptHours(rule.id)).toBe(kept);
    expect(
      await dashboard.db.selectFrom("ai_cost_windows").select("settings_key").execute(),
    ).toEqual([{ settings_key: "" }]);
    const later = new Date(at.getTime() + MINUTE);
    const second = await evaluate(rule.id, later);
    expect(second.reading).toMatchObject({
      value: expect.closeTo((await fullScan(later)).costUsd, 9),
      noPriceCalls: 0,
    });
    expect(second.reading.value).toBeCloseTo(Number(first.reading.value) + 20 * 2, 6);

    // A row written past the routes still changes the prices' fingerprint: added up again.
    await dashboard.db
      .updateTable("ai_model_prices")
      .set({ input: 2, output: 2 })
      .where("model", "=", "local-llama")
      .execute();
    const third = await evaluate(rule.id, new Date(later.getTime() + MINUTE));
    expect(third.reading.value).toBeCloseTo(Number(first.reading.value) + 20 * 4, 6);
  });
});

describe("the list", () => {
  test("called models with their calls of the last 30 days, the bundled ones, and where prices come from", async () => {
    const other = (await insertProject(dashboard.db, { name: `Other ${hex(3)}` })).id;
    const recent = new Date(Date.now() - DAY);
    await insertCalls([
      { model: SONNET, at: recent },
      { model: "List-Llama", at: recent },
      { model: "list-llama", at: recent },
      // Older than 30 days: not counted.
      { model: "list-llama", at: new Date(Date.now() - 31 * DAY) },
    ]);
    await insertCalls([{ model: "list-llama", at: recent }], other);
    await setPrice("list-snapshot", { input: 1, output: 2, cacheRead: 0.1 });
    const response = await dashboard.app.inject({
      method: "GET",
      url: "/api/settings/ai-models",
      headers: { cookie: dashboard.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      callsDays: number;
      models: { model: string; calls: number; source: string | null }[];
    }>();
    expect(body.callsDays).toBe(30);
    const byModel = new Map(body.models.map((model) => [model.model, model]));
    expect(byModel.get("list-llama")).toMatchObject({
      model: "list-llama",
      provider: "anthropic",
      calls: 3,
      price: null,
      source: null,
      builtIn: null,
      prices: [],
      priceAs: null,
    });
    expect(byModel.get(SONNET)).toMatchObject({
      calls: expect.any(Number),
      source: "built_in",
      builtIn: {
        label: "Claude Sonnet 4.6",
        checked: sonnet.checked,
        source: sonnet.source,
        notes: sonnet.notes ?? null,
      },
      price: { input: sonnet.input, output: sonnet.output },
    });
    expect(byModel.get("list-snapshot")).toMatchObject({
      calls: 0,
      source: "custom",
      price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: null },
      prices: [{ effectiveFrom: null, updatedBy: "Ada Owner", rates: { input: 1 } }],
    });
    expect(body.models.length).toBeGreaterThan(100);
    const calls = body.models.map((model) => model.calls);
    expect(calls).toEqual(calls.toSorted((a, b) => b - a));
  });
  test("the list reads only the instance's projects", async () => {
    // Calls of a project the instance no longer has (deleted, awaiting the purge).
    projectId = randomUUID();
    await insertCalls([{ model: "ghost-model", at: new Date(Date.now() - DAY) }]);
    const response = await dashboard.app.inject({
      method: "GET",
      url: "/api/settings/ai-models",
      headers: { cookie: dashboard.cookie },
    });
    const models = response
      .json<{ models: { model: string }[] }>()
      .models.map((item) => item.model);
    expect(models).not.toContain("ghost-model");
  });
});

describe("who may change prices, and the checks", () => {
  test("the owner and admins; not members, whatever their areas", async () => {
    const admin = await signedInUser(dashboard, {
      name: "Ad",
      email: `admin-${hex(3)}@example.com`,
      role: "admin",
    });
    const member = await signedInUser(dashboard, {
      name: "Me",
      email: `member-${hex(3)}@example.com`,
      grants: { projects: "all", areas: { monitoring: "view", uptime_alerts: "manage" } },
    });
    const list = (cookie: string) =>
      dashboard.app.inject({ method: "GET", url: "/api/settings/ai-models", headers: { cookie } });
    expect((await list(admin.cookie)).statusCode).toBe(200);
    expect((await list(member.cookie)).statusCode).toBe(403);
    const body = priceBody("local-llama", {});
    expect((await send("PUT", "/settings/ai-models/price", body, admin.cookie)).statusCode).toBe(
      200,
    );
    expect((await send("PUT", "/settings/ai-models/price", body, member.cookie)).statusCode).toBe(
      403,
    );
    expect(
      (await send("POST", "/settings/ai-models/reset", { model: "x" }, member.cookie)).statusCode,
    ).toBe(403);
    expect(
      (
        await send(
          "PUT",
          "/settings/ai-models/price-as",
          { provider: "x", model: "y", priceAs: { provider: "anthropic", model: SONNET } },
          member.cookie,
        )
      ).statusCode,
    ).toBe(403);
  });

  test("refuse prices below 0, past the bound, with too many decimals, and days that do not exist", async () => {
    expect(await putPrice(priceBody("m", { input: -1 }))).toEqual([400, "FST_ERR_VALIDATION"]);
    expect(await putPrice(priceBody("m", { output: 10_001 }))).toEqual([400, "FST_ERR_VALIDATION"]);
    expect(await putPrice(priceBody("m", { cacheRead: 0.1234567 }))).toEqual([
      400,
      "invalid_price",
    ]);
    expect(await putPrice(priceBody("m", { input: 0.123456 }))).toEqual([200, undefined]);
    expect(await putPrice(priceBody("m", {}, "2026-02-31"))).toEqual([400, "invalid_day"]);
    expect(await putPrice(priceBody("m", {}, "26-02-01"))).toEqual([400, "FST_ERR_VALIDATION"]);
    expect(await putPrice({ ...priceBody("m", {}), model: "a\u0000b" })).toEqual([
      400,
      "FST_ERR_VALIDATION",
    ]);
    expect(await putPrice({ ...priceBody("m", {}), model: "   " })).toEqual([400, "invalid_name"]);
    const { input, ...noInput } = priceBody("m", {});
    expect(input).toBe(1);
    expect(await putPrice(noInput)).toEqual([400, "FST_ERR_VALIDATION"]);
  });

  test("price as: not itself, not a built-in model, a target with a price, one level", async () => {
    expect(await priceAs("snap", "Snap")).toEqual([400, "price_as_itself"]);
    expect(await priceAs(SONNET, "snap")).toEqual([400, "has_built_in_price"]);
    expect(await priceAs("snap", "nothing-priced")).toEqual([400, "target_has_no_price"]);
    expect(await priceAs("snap", SONNET)).toEqual([200, undefined]);
    await setPrice("local-llama", {});
    expect(await priceAs("snap-2", "local-llama")).toEqual([200, undefined]);
    // snap is priced as another, and local-llama is snap-2's target: either would make a chain.
    await setPrice("snap", {}, "2026-01-01");
    expect(await priceAs("snap-3", "snap")).toEqual([409, "target_is_priced_as"]);
    expect(await priceAs("local-llama", SONNET)).toEqual([409, "others_priced_as_this"]);
  });

  test("refuse a reset of a model others are priced as, naming them", async () => {
    await setPrice("base-model", {});
    expect(await priceAs("snap-a", "base-model")).toEqual([200, undefined]);
    const response = await send("POST", "/settings/ai-models/reset", { model: "base-model" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "others_priced_as_this",
      models: ["snap-a"],
      message: "Priced as this model: snap-a. Reset those first.",
    });
  });

  test("refuse prices past 100 for a model and 1,000 for the instance", async () => {
    await dashboard.db
      .insertInto("ai_model_prices")
      .values(
        Array.from({ length: 100 }, (_, index) => ({
          provider: "x",
          model: "many",
          effective_from: new Date(Date.UTC(2026, 0, 1 + index)),
          input: 1,
          output: 1,
          cache_read: null,
          cache_write: null,
          price_as_provider: null,
          price_as_model: null,
          created_by: null,
          updated_by: null,
        })),
      )
      .execute();
    expect(await putPrice(priceBody("many", {}, "2026-11-01"))).toEqual([
      409,
      "too_many_model_prices",
    ]);
    // A day it has already: replaced, not added.
    expect(await putPrice(priceBody("many", {}, "2026-01-01"))).toEqual([200, undefined]);
    await dashboard.db
      .insertInto("ai_model_prices")
      .values(
        Array.from({ length: 900 }, (_, index) => ({
          provider: "x",
          model: `filler-${index}`,
          effective_from: null,
          input: 1,
          output: 1,
          cache_read: null,
          cache_write: null,
          price_as_provider: null,
          price_as_model: null,
          created_by: null,
          updated_by: null,
        })),
      )
      .execute();
    expect(await putPrice(priceBody("one-more", {}))).toEqual([409, "too_many_prices"]);
    expect(
      await dashboard.db
        .selectFrom("ai_model_prices")
        .select("id")
        .where("model", "=", "one-more")
        .execute(),
    ).toEqual([]);
  });

  test("changes need the dashboard's Origin", async () => {
    const response = await dashboard.app.inject({
      method: "PUT",
      url: "/api/settings/ai-models/price",
      headers: { cookie: dashboard.cookie, origin: "https://evil.example.com" },
      payload: priceBody("m", {}),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "untrusted_origin" });
    const reset = await dashboard.app.inject({
      method: "POST",
      url: "/api/settings/ai-models/reset",
      headers: { cookie: dashboard.cookie },
      payload: { model: "m" },
    });
    expect(reset.statusCode).toBe(403);
  });
});

describe("the limit on changes", () => {
  let limited: Awaited<ReturnType<typeof signedInDashboard>>;
  beforeAll(async () => {
    limited = await signedInDashboard({
      aiModels: { changeLimit: { capacity: 2, refillPerSecond: 1 / 3600 } },
    });
  });
  afterAll(async () => {
    await limited?.close();
  });
  const change = (method: "PUT" | "POST", url: string, payload: object) =>
    limited.app.inject({
      method,
      url: `/api/settings/ai-models/${url}`,
      headers: { cookie: limited.cookie, origin: PUBLIC_URL },
      payload,
    });

  test("each user's changes are limited, across the routes", async () => {
    expect((await change("PUT", "price", priceBody("m", {}))).statusCode).toBe(200);
    expect((await change("POST", "reset", { model: "m" })).statusCode).toBe(200);
    const refused = await change("PUT", "price", priceBody("m", {}));
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("without ClickHouse", () => {
  let down: Awaited<ReturnType<typeof signedInDashboard>>;
  beforeAll(async () => {
    down = await signedInDashboard({
      telemetry: { clickhouse: createClient({ url: "http://127.0.0.1:1", request_timeout: 2000 }) },
    });
  });
  afterAll(async () => {
    await down?.close();
  });

  test("the list still answers, its calls not counted, and prices stay editable", async () => {
    await insertProject(down.db, { name: "Shop" });
    const response = await down.app.inject({
      method: "GET",
      url: "/api/settings/ai-models",
      headers: { cookie: down.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ callsCounted: boolean; models: { calls: number | null }[] }>();
    expect(body.callsCounted).toBe(false);
    expect(new Set(body.models.map((model) => model.calls))).toEqual(new Set([null]));
    const change = await down.app.inject({
      method: "PUT",
      url: "/api/settings/ai-models/price",
      headers: { cookie: down.cookie, origin: PUBLIC_URL },
      payload: priceBody("m", {}),
    });
    expect(change.statusCode).toBe(200);
  });
});
