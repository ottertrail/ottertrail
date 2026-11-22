import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { costOf, priceOf } from "../src/ai/prices.ts";
import { aiWindow } from "../src/ai/report.ts";
import { aiWindowAt } from "../src/alerts/ai-rules.ts";
import type { AlertContext } from "../src/alerts/fire.ts";
import type { AiCostSettings, RuleKind } from "../src/alerts/kinds.ts";
import {
  evaluateTelemetryPass,
  evaluateTelemetryRule,
  takeDueRules,
  telemetryRules,
} from "../src/alerts/telemetry-rules.ts";
import { isPayload, type NotificationPayload } from "../src/notifications/events.ts";
import { nanosText } from "../src/telemetry/normalize.ts";
import { TRACE_MESSAGES } from "../src/telemetry/proto/definitions.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject, setInstanceTimeZone } from "./helpers/projects.ts";
import { encodeProtobuf, keyValues, secretKeyOf } from "./helpers/telemetry.ts";

/**
 * AI alert rules (docs/ai-usage.md, "Alerts"; alerts/ai-rules.ts): the
 * estimated cost of a window above a value, for one feature or model or
 * all, and the failed share of a window's calls above a share with a
 * minimum of calls; each fired, resolved after its time back, and quiet
 * without data, from calls sent over OTLP; the worker's pass; and the
 * rule routes' checks.
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let context: AlertContext;
let channelId = "";
let projectId = "";
let secretKey = "";

const PUBLIC = "https://ottertrail.example.com";
const MINUTE = 60_000;
/** The evaluations' clock: a whole minute, two hours ago. */
const AT = new Date(Math.floor((Date.now() - 2 * 60 * MINUTE) / MINUTE) * MINUTE);
const after = (minutes: number) => new Date(AT.getTime() + minutes * MINUTE);
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

beforeAll(async () => {
  dashboard = await signedInDashboard();
  context = { db: dashboard.db, publicUrl: PUBLIC };
});

afterAll(async () => {
  await dashboard?.close();
});

beforeEach(async () => {
  await dashboard.db.deleteFrom("alert_rules").execute();
  await dashboard.db.deleteFrom("notification_channels").execute();
  const channel = await dashboard.db
    .insertInto("notification_channels")
    .values({
      name: "Team",
      kind: "webhook",
      webhook_url: "https://hooks.example.com/ottertrail",
      webhook_secret: "x".repeat(43),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  channelId = channel.id;
  projectId = (await insertProject(dashboard.db, { name: "Shop" })).id;
  secretKey = await secretKeyOf(dashboard.db, projectId);
});

async function insertRule(kind: RuleKind, settings: object) {
  const row = await dashboard.db
    .insertInto("alert_rules")
    .values({
      project_id: projectId,
      name: `Rule ${kind}`,
      kind,
      settings: JSON.stringify(settings),
      channel_ids: [channelId],
      active_since: AT,
      created_at: AT,
      updated_at: AT,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function evaluate(ruleId: string, at: Date) {
  const rules = await telemetryRules(dashboard.db, projectId);
  const rule = rules.find((item) => item.id === ruleId);
  if (rule === undefined) throw new Error("no such rule");
  return evaluateTelemetryRule(context, dashboard.reader, rule, at);
}

async function sent(): Promise<NotificationPayload[]> {
  const rows = await dashboard.db
    .selectFrom("notification_deliveries")
    .select(["payload"])
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows
    .map((row) => {
      if (!isPayload(row.payload)) throw new Error("not a payload");
      return row.payload;
    })
    .filter((payload) => payload.project?.id === projectId);
}

interface Call {
  at: Date;
  model?: string;
  input?: number;
  output?: number;
  feature?: string;
  failed?: boolean;
}

const SONNET = "claude-sonnet-4-6";

/** Model calls over OTLP, as an instrumentation sends them. */
async function sendCalls(calls: Call[]) {
  const spans = calls.map((call) => {
    const start = BigInt(call.at.getTime()) * 1_000_000n;
    return {
      traceId: Buffer.from(hex(16), "hex"),
      spanId: Buffer.from(hex(8), "hex"),
      name: "chat",
      kind: 3,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + 500_000_000n),
      attributes: keyValues({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": call.model ?? SONNET,
        "gen_ai.usage.input_tokens": call.input ?? 0,
        "gen_ai.usage.output_tokens": call.output ?? 0,
        ...(call.feature === undefined ? {} : { "ottertrail.feature": call.feature }),
        ...(call.failed === true ? { "error.type": "overloaded_error" } : {}),
      }),
    };
  });
  const response = await dashboard.app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${secretKey}` },
    payload: encodeProtobuf(TRACE_MESSAGES, {
      resourceSpans: [
        {
          resource: { attributes: keyValues({ "service.name": "assistant" }) },
          scopeSpans: [{ spans }],
        },
      ],
    }),
  });
  expect(response.statusCode).toBe(200);
}

const times = (count: number, call: Call): Call[] => Array.from({ length: count }, () => call);

/** What a million input tokens and 100,000 output tokens of Sonnet 4.6 cost. */
const sonnetPrice = priceOf(SONNET);
const MILLION_COST =
  sonnetPrice === null
    ? Number.NaN
    : costOf(sonnetPrice, { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 });

const costRule = (settings: Partial<AiCostSettings>) =>
  insertRule("ai_cost", {
    environment: "production",
    feature: null,
    model: null,
    costWindow: "1h",
    thresholdUsd: 1,
    ...settings,
  });

describe("AI cost", () => {
  test("fires above the value over the last hour, for one feature; says the cost is an estimate", async () => {
    const all = await costRule({ thresholdUsd: MILLION_COST * 1.5 });
    const chat = await costRule({ thresholdUsd: MILLION_COST * 0.5, feature: "support-chat" });
    await sendCalls([
      { at: after(-30), input: 1_000_000, output: 100_000, feature: "support-chat" },
      // Another feature's, and a model with no price: counted by the rule on all only.
      { at: after(-20), input: 600_000, output: 60_000, feature: "search" },
      { at: after(-20), model: "llama3.3:70b", input: 1000, feature: "search" },
      // Outside the hour.
      { at: after(-62), input: 5_000_000, feature: "support-chat" },
    ]);
    expect(await evaluate(all, AT)).toMatchObject({
      outcome: "sent",
      reading: { value: expect.closeTo(MILLION_COST * 1.6, 9), calls: 3, noPriceCalls: 1 },
    });
    expect(await evaluate(chat, AT)).toMatchObject({
      outcome: "sent",
      reading: { value: expect.closeTo(MILLION_COST, 9), calls: 1, noPriceCalls: 0 },
    });
    const [first, second] = await sent();
    expect(first).toMatchObject({
      type: "ai.cost",
      url: `${PUBLIC}/projects/${projectId}/ai?env=%22production%22`,
      subject: {
        type: "ai_cost",
        costWindow: "1h",
        calls: 3,
        noPriceCalls: 1,
        estimated: true,
        feature: null,
        model: null,
      },
    });
    expect(first?.message).toMatch(
      /^Shop: the estimated AI cost in production was \$[0-9.]+ over the last hour, above the rule's \$[0-9.]+\. The cost is an estimate, from token counts at list prices\. 1 call of models without a price is not counted\.$/,
    );
    expect(second?.message).toMatch(
      /^Shop: the estimated AI cost for the feature support-chat in production was/,
    );
    expect(second?.url).toBe(
      `${PUBLIC}/projects/${projectId}/ai?env=%22production%22&feature=%22support-chat%22`,
    );
  });

  test("resolves once at or below the value for an hour", async () => {
    const ruleId = await costRule({ thresholdUsd: MILLION_COST * 0.5 });
    await sendCalls([{ at: after(-10), input: 1_000_000, output: 100_000 }]);
    expect((await evaluate(ruleId, AT)).outcome).toBe("sent");
    // The call leaves the hour at AT + 51: back at or below from then.
    expect((await evaluate(ruleId, after(50))).outcome).toBe("none");
    expect(await evaluate(ruleId, after(52))).toMatchObject({
      outcome: "waiting",
      reading: { value: 0, calls: 0 },
    });
    expect((await evaluate(ruleId, after(100))).outcome).toBe("waiting");
    expect((await evaluate(ruleId, after(112))).outcome).toBe("sent");
    expect((await sent()).map((payload) => payload.type)).toEqual(["ai.cost", "ai.cost_resolved"]);
    expect((await sent())[1]?.message).toMatch(
      /stayed at or below \$[0-9.]+ for 60 minutes: \$0 over the last hour\. The cost is an estimate/,
    );
  });

  test("the month so far starts at midnight of its first day, in the instance's timezone", async () => {
    const month = { costWindow: "month", thresholdUsd: 1, environment: "production" } as const;
    const settings = { ...month, feature: null, model: null };
    await setInstanceTimeZone(dashboard.db, "Europe/Berlin");
    expect(
      await aiWindowAt(dashboard.db, settings, new Date("2026-11-22T10:00:00Z"), MINUTE),
    ).toEqual({
      from: new Date("2026-10-31T23:00:00Z"),
      to: new Date("2026-11-22T09:59:00Z"),
    });
    // Just after the month began: an empty window, not one that ends before it starts.
    expect(
      await aiWindowAt(dashboard.db, settings, new Date("2026-10-31T23:00:30Z"), MINUTE),
    ).toEqual({ from: new Date("2026-10-31T23:00:00Z"), to: new Date("2026-10-31T23:00:00Z") });
    await setInstanceTimeZone(dashboard.db, "UTC");
    expect(
      (await aiWindowAt(dashboard.db, { ...settings, costWindow: "1d" }, AT, MINUTE)).from,
    ).toEqual(new Date(AT.getTime() - MINUTE - 24 * 60 * MINUTE));
  });
});

/** Calls straight into ai_calls, at fixed times: a window's hours of the past. */
async function insertCalls(moments: Date[]) {
  await dashboard.reader.client.insert({
    table: "ai_calls",
    values: moments.map((time) => ({
      project_id: projectId,
      timestamp: nanosText(BigInt(time.getTime()) * 1_000_000n),
      id: hex(24),
      model: SONNET,
      environment: "production",
      input_tokens: 1000,
      output_tokens: 100,
    })),
    format: "JSONEachRow",
  });
}

/** The rule's window at `at`, read whole from ClickHouse: what the kept hours must add up to. */
async function fullScan(settings: AiCostSettings, at: Date) {
  const window = await aiWindowAt(dashboard.db, settings, at, MINUTE);
  return aiWindow(dashboard.reader, { projectId, environment: "production", ...window }, {});
}

const keptHours = async (ruleId: string) =>
  (
    await dashboard.db
      .selectFrom("ai_cost_hours")
      .select("hour")
      .where("rule_id", "=", ruleId)
      .execute()
  ).length;

const settings = (costWindow: "1d" | "month"): AiCostSettings => ({
  environment: "production",
  feature: null,
  model: null,
  costWindow,
  thresholdUsd: 1_000_000,
});

describe("AI cost over kept hours", () => {
  test("the month and the last 24 hours add up as a full scan does; a late call counts after midnight", async () => {
    const start = Date.parse("2026-10-01T00:00:00Z");
    // A call every 37 minutes over three days.
    await insertCalls(
      Array.from(
        { length: Math.floor((3 * 24 * 60) / 37) },
        (_, i) => new Date(start + i * 37 * MINUTE),
      ),
    );
    const month = await costRule(settings("month"));
    const day = await costRule(settings("1d"));
    const check = async (at: Date) => {
      for (const [ruleId, window] of [
        [month, "month"],
        [day, "1d"],
      ] as const) {
        const scan = await fullScan(settings(window), at);
        const { reading } = await evaluate(ruleId, at);
        expect({ window, at, calls: reading.calls, value: reading.value }).toEqual({
          window,
          at,
          calls: scan.calls,
          value: expect.closeTo(scan.costUsd, 9),
        });
      }
    };
    const t1 = new Date("2026-10-02T10:30:00Z");
    await check(t1);
    expect(await keptHours(month)).toBeGreaterThan(30);
    expect(await keptHours(day)).toBeGreaterThan(20);
    await check(new Date(t1.getTime() + MINUTE));
    await check(new Date(t1.getTime() + 137 * MINUTE));

    // A call that arrives late, for an hour already kept: not counted until the next midnight.
    await insertCalls([new Date("2026-10-02T03:10:00Z")]);
    const later = new Date(t1.getTime() + 140 * MINUTE);
    const scan = await fullScan(settings("month"), later);
    expect((await evaluate(month, later)).reading.calls).toBe(scan.calls - 1);
    await check(new Date("2026-10-03T00:30:00Z"));
    // A new month starts from nothing.
    await check(new Date("2026-11-01T05:00:00Z"));
    expect((await fullScan(settings("month"), new Date("2026-11-01T05:00:00Z"))).calls).toBe(0);
  });
});

describe("AI failures", () => {
  test("fires above the failed share, for one model; not below the minimum of calls", async () => {
    const ruleId = await insertRule("ai_failures", {
      environment: "production",
      feature: null,
      model: SONNET,
      windowMinutes: 10,
      thresholdPercent: 10,
      minCalls: 20,
    });
    await sendCalls([
      ...times(16, { at: after(-5) }),
      ...times(3, { at: after(-5), failed: true }),
      // Another model's failures do not count.
      ...times(10, { at: after(-5), model: "gpt-5.4-mini", failed: true }),
    ]);
    expect(await evaluate(ruleId, AT)).toMatchObject({
      outcome: "none",
      reading: { value: null, calls: 19, failed: 3 },
    });
    await sendCalls([{ at: after(-4) }]);
    expect(await evaluate(ruleId, AT)).toMatchObject({
      outcome: "sent",
      reading: { value: 15, calls: 20, failed: 3 },
    });
    expect((await sent())[0]).toMatchObject({
      type: "ai.failures",
      message:
        "Shop: 15% of AI calls for the model claude-sonnet-4-6 in production failed over the last 10 minutes, above the rule's 10%: 3 of 20 calls.",
      subject: {
        type: "ai_failures",
        model: SONNET,
        windowMinutes: 10,
        calls: 20,
        failed: 3,
        failedPercent: 15,
        thresholdPercent: 10,
      },
    });
  });

  test('a feature of "" is the calls that name none', async () => {
    const created = await api("POST", rules(), {
      kind: "ai_failures",
      settings: { thresholdPercent: 10, minCalls: 2, feature: "" },
      channelIds: [channelId],
    });
    expect(created.json()).toMatchObject({ rule: { settings: { feature: "" } } });
    const ruleId = created.json<{ rule: { id: string } }>().rule.id;
    await sendCalls([
      { at: after(-3), failed: true },
      { at: after(-3) },
      // A feature's calls are not the unlabeled ones.
      ...times(5, { at: after(-3), feature: "support-chat" }),
    ]);
    expect(await evaluate(ruleId, AT)).toMatchObject({
      outcome: "sent",
      reading: { value: 50, calls: 2, failed: 1 },
    });
    expect((await sent())[0]?.message).toBe(
      "Shop: 50% of AI calls with no feature in production failed over the last 10 minutes, above the rule's 10%: 1 of 2 calls.",
    );
  });

  test("the worker takes AI rules with the others and evaluates them", async () => {
    const ruleId = await insertRule("ai_failures", {
      environment: "production",
      feature: null,
      model: null,
      windowMinutes: 10,
      thresholdPercent: 0,
      minCalls: 1,
    });
    await sendCalls([{ at: after(-3), failed: true }]);
    const taken = await takeDueRules(dashboard.db, AT);
    expect(taken.map((rule) => rule.id)).toEqual([ruleId]);
    const pass = await evaluateTelemetryPass(context, taken, {
      readerOf: () => dashboard.reader,
      now: () => AT,
    });
    expect(pass.results).toMatchObject([{ result: { outcome: "sent", reading: { value: 100 } } }]);
  });
});

function api(method: "POST" | "GET", path: string, payload?: object) {
  return dashboard.app.inject({
    method,
    url: `/api${path}`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    ...(payload === undefined ? {} : { payload }),
  });
}
const rules = () => `/projects/${projectId}/alert-rules`;
const refused = async (body: object) => {
  const response = await api("POST", rules(), { channelIds: [channelId], ...body });
  expect(response.statusCode).toBe(400);
  const answer = response.json<{ error: string; code?: string }>();
  return answer.code ?? answer.error;
};

describe("the rule routes", () => {
  test("save AI rules with defaults, and warn when no call has arrived", async () => {
    const cost = await api("POST", rules(), {
      kind: "ai_cost",
      settings: { thresholdUsd: 25, feature: "support-chat" },
      channelIds: [channelId],
    });
    expect(cost.statusCode).toBe(201);
    expect(cost.json()).toMatchObject({
      rule: {
        name: "AI cost",
        kind: "ai_cost",
        settings: {
          environment: "production",
          feature: "support-chat",
          model: null,
          costWindow: "1d",
          thresholdUsd: 25,
        },
      },
      warning: {
        reason: "not_seen",
        message:
          "No AI call for the feature support-chat arrived in production in the last 24 hours. The rule is saved. Monitoring starts when calls arrive.",
      },
    });
    await sendCalls([{ at: new Date(Date.now() - MINUTE), feature: "support-chat" }]);
    const failures = await api("POST", rules(), {
      kind: "ai_failures",
      settings: { thresholdPercent: 5, environment: "Production" },
      channelIds: [channelId],
    });
    expect(failures.json()).toMatchObject({
      rule: {
        name: "AI failures",
        settings: {
          environment: "production",
          feature: null,
          model: null,
          windowMinutes: 10,
          thresholdPercent: 5,
          minCalls: 20,
        },
      },
      warning: null,
    });
  });

  test("refuse settings the AI kinds do not take", async () => {
    expect(await refused({ kind: "ai_cost", settings: {} })).toBe("invalid_threshold");
    expect(await refused({ kind: "ai_cost", settings: { thresholdUsd: 0 } })).toBe(
      "FST_ERR_VALIDATION",
    );
    expect(
      await refused({ kind: "ai_cost", settings: { thresholdUsd: 5, costWindow: "1w" } }),
    ).toBe("FST_ERR_VALIDATION");
    expect(
      await refused({ kind: "ai_cost", settings: { thresholdUsd: 5, model: "m".repeat(101) } }),
    ).toBe("FST_ERR_VALIDATION");
    expect(await refused({ kind: "ai_failures", settings: {} })).toBe("invalid_threshold");
    expect(await refused({ kind: "ai_failures", settings: { thresholdPercent: 100 } })).toBe(
      "invalid_threshold",
    );
    expect(
      await refused({ kind: "ai_failures", settings: { thresholdPercent: 5, minCalls: 0 } }),
    ).toBe("FST_ERR_VALIDATION");
    expect(
      await refused({ kind: "ai_failures", settings: { thresholdPercent: 5, windowMinutes: 61 } }),
    ).toBe("FST_ERR_VALIDATION");
  });
});
