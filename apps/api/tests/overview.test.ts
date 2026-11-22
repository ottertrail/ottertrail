import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { ALL_AREAS, type Areas } from "../src/access/areas.ts";
import { costOf, priceOf } from "../src/ai/prices.ts";
import { purgeDeletedProjects, retryFirstSeenRebuilds } from "../src/clickhouse/delete-events.ts";
import { insertRows } from "../src/clickhouse/insert.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { completeOrder, WIDGET_IDS } from "../src/overview/layout.ts";
import { mondayOf } from "../src/overview/signed-in-users.ts";
import { deleteExpiredEvents } from "../src/retention/retention.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";

/**
 * The project overview (docs/dashboard.md, "Overview"): each widget's
 * numbers on a small set of events, spans, AI calls, checks, and alerts,
 * worked out by hand in the comments; who reaches which widget; and each user's own
 * layout.
 *
 * The instance is in UTC, and the clock stands at noon today: "7d" is the
 * last six days and today, compared with the seven days before, up to
 * noon of the seventh (a running period is compared up to the same moment).
 */

const DAY_MS = 86_400_000;
const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date(`${TODAY}T12:00:00.000Z`);
/** "YYYY-MM-DD", `days` before today. */
const day = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString().slice(0, 10);
/** A moment on the day `days` before today, at `time` (UTC). */
const at = (days: number, time: string) => new Date(`${day(days)}T${time}:00.000Z`);

const FORBIDDEN = {
  error: "forbidden",
  message: "You don't have access to this. Ask the instance's owner or an admin if you need it.",
};
const NOT_FOUND = { error: "not_found", message: "No project has this ID." };

/** The widgets' routes and the area each needs. */
const WIDGET_AREAS = {
  attention: "uptime_alerts",
  errors: "errors",
  uptime: "uptime_alerts",
  services: "monitoring",
  "ai-cost": "monitoring",
  speed: "web_analytics",
  "main-goal": "product_analytics",
  traffic: "web_analytics",
  goals: "product_analytics",
  users: "product_analytics",
  sources: "web_analytics",
} as const;

/** The firing alerts' rule names, sorted. */
const names = (body: { alerts: { ruleName: string }[] }) =>
  body.alerts.map((alert) => alert.ruleName).toSorted();
const layoutUrl = (projectId: string) => `/api/projects/${projectId}/overview/layout`;
/** A layout's widgets, a hidden one marked with "-". */
const ids = (body: { widgets: { id: string; hidden: boolean }[] }) =>
  body.widgets.map((item) => (item.hidden ? `-${item.id}` : item.id));

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let site = { id: "" };
let other = { id: "" };

function send(
  method: "GET" | "PUT" | "DELETE" | "POST" | "PATCH",
  url: string,
  { cookie = dashboard.cookie, payload }: { cookie?: string; payload?: object } = {},
) {
  return dashboard.app.inject({
    method,
    url,
    headers: {
      cookie,
      origin: PUBLIC_URL,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function widget(name: string, { cookie = dashboard.cookie, projectId = site.id } = {}) {
  const response = await send("GET", `/api/projects/${projectId}/overview/${name}`, { cookie });
  expect({ name, status: response.statusCode }).toEqual({ name, status: 200 });
  return response.json();
}

const member = (email: string, areas: Partial<Areas>, projects: string[] = [site.id]) =>
  signedInUser(dashboard, {
    name: email,
    email,
    grants: {
      projects,
      areas: {
        web_analytics: "none",
        product_analytics: "none",
        errors: "none",
        replays: "none",
        users: "none",
        monitoring: "none",
        uptime_alerts: "none",
        ...areas,
      },
    },
  });

/** A browser event of the site, in production. */
const event = (name: string, occurredAt: Date, more: Partial<NewEvent> = {}): NewEvent => ({
  eventId: randomUUID(),
  name,
  occurredAt,
  ...more,
});

/** A server span, as the spans table holds it. */
const span = (
  service: string,
  timestamp: Date,
  durationMs: number,
  { kind = "server", status = "ok" }: { kind?: string; status?: string } = {},
) => ({
  project_id: site.id,
  timestamp: timestamp.toISOString().replace("T", " ").replace("Z", ""),
  id: randomUUID().replaceAll("-", "").padEnd(48, "0"),
  trace_id: randomUUID().replaceAll("-", ""),
  span_id: randomUUID().replaceAll("-", "").slice(0, 16),
  parent_span_id: "",
  name: "GET /",
  kind,
  duration_ns: durationMs * 1_000_000,
  status_code: status,
  status_message: "",
  service,
  release: "",
  environment: "production",
  resource_attributes: {},
  attributes: {},
  dropped_attributes_count: 0,
  events: "[]",
  dropped_events_count: 0,
  links: "[]",
  dropped_links_count: 0,
  scope_name: "",
  scope_version: "",
});

/** An AI call, as the ai_calls table holds it. */
const aiCall = (
  timestamp: Date,
  model: string,
  inputTokens: number,
  environment = "production",
) => ({
  project_id: site.id,
  timestamp: timestamp.toISOString().replace("T", " ").replace("Z", ""),
  id: randomUUID(),
  environment,
  model,
  input_tokens: inputTokens,
  duration_ns: 1_000_000_000,
});
const SONNET = "claude-sonnet-4-6";
const MINI = "gpt-5.4-mini";
/** What `input` tokens of a model cost, with no output. */
function inputCost(model: string, input: number): number {
  const price = priceOf(model);
  if (price === null) throw new Error(`no price for ${model}`);
  return costOf(price, { input, output: 0, cacheRead: 0, cacheWrite: 0 });
}

const ERROR_A = {
  type: "TypeError",
  message: "x is undefined",
  handled: false,
  fingerprint: "1-aaaaaaaaaaaaaaaaaaaa",
};
const ERROR_B = {
  type: "ReferenceError",
  message: "process is not defined",
  handled: false,
  fingerprint: "1-bbbbbbbbbbbbbbbbbbbb",
};

/** A project, created as the dashboard creates one. */
async function createProject(name: string) {
  const response = await send("POST", "/api/projects", {
    payload: { name, allowedHostnames: [`${name.toLowerCase().replace(/\s/g, "-")}.example`] },
  });
  return response.json().project;
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  site = await createProject("Some site");
  other = await createProject("Other site");

  // Visitor 1, yesterday: from google.com, the home page then pricing, and
  // signs up as u-new. Visitor 2, two days ago: the home page, direct.
  // Visitor 3, nine days ago (the period before, before noon): the home page.
  // u-old was first seen 30 days ago, then eight days ago, then yesterday.
  await dashboard.store(site.id, [
    event("pageview", at(1, "10:00"), {
      path: "/",
      referrer: "https://www.google.com/",
      visitorId: "1",
    }),
    event("pageview", at(1, "10:01"), { path: "/pricing", visitorId: "1" }),
    event("signup", at(1, "10:02"), { path: "/pricing", visitorId: "1", userId: "u-new" }),
    event("pageview", at(2, "09:00"), { path: "/", visitorId: "2" }),
    event("pageview", at(9, "09:00"), { path: "/", visitorId: "3" }),
    event("pageview", at(30, "09:00"), { path: "/", visitorId: "4", userId: "u-old" }),
    event("pageview", at(8, "09:00"), { path: "/", visitorId: "5", userId: "u-old" }),
    event("pageview", at(1, "11:00"), { path: "/", visitorId: "6", userId: "u-old" }),
    // Errors: A twice yesterday and once eight days ago; B, new, once yesterday.
    event("error", at(1, "10:05"), { path: "/", visitorId: "1", userId: "u-new", error: ERROR_A }),
    event("error", at(1, "10:06"), { path: "/", visitorId: "2", error: ERROR_A }),
    event("error", at(8, "10:00"), { path: "/", visitorId: "3", error: ERROR_A }),
    event("error", at(1, "10:07"), { path: "/", visitorId: "1", error: ERROR_B }),
    // Page loads: a slow one on a phone, and one in staging (not counted).
    event("vitals", at(1, "10:00"), {
      path: "/",
      visitorId: "1",
      properties: { lcp: 4600, inp: 520, cls: 0.3 },
      client: { browser: "Safari", browserVersion: "18", os: "iOS", deviceType: "mobile" },
    }),
    event("vitals", at(1, "10:00"), {
      path: "/",
      visitorId: "1",
      environment: "staging",
      properties: { lcp: 1000 },
      client: { browser: "Safari", browserVersion: "18", os: "iOS", deviceType: "mobile" },
    }),
  ]);

  // web: three requests yesterday (10, 20, 30 ms; one failed), one eight
  // days ago; billing: one yesterday; a client span, which is no request.
  await insertRows(dashboard.reader.client, "spans", [
    span("web", at(1, "10:00"), 10),
    span("web", at(1, "10:01"), 20, { status: "error" }),
    span("web", at(1, "10:02"), 30),
    span("web", at(8, "10:00"), 40),
    span("billing", at(1, "10:03"), 2000),
    span("web", at(1, "10:04"), 5, { kind: "client" }),
  ]);

  // AI calls: two of Sonnet and one of a mini model yesterday, one of a
  // model without a price; one in staging (not counted); one of Sonnet
  // eight days ago (the period before).
  await insertRows(dashboard.reader.client, "ai_calls", [
    aiCall(at(1, "10:00"), SONNET, 1_000_000),
    aiCall(at(1, "10:01"), SONNET, 1_000_000),
    aiCall(at(1, "10:02"), MINI, 1_000_000),
    aiCall(at(1, "10:03"), "llama3.3:70b", 1_000_000),
    aiCall(at(1, "10:04"), SONNET, 9_000_000, "staging"),
    aiCall(at(8, "10:00"), SONNET, 500_000),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("each widget's numbers", () => {
  test("traffic: the period's visitors, visits, and pageviews against the period before, per day", async () => {
    const traffic = await widget("traffic");
    expect(traffic).toMatchObject({
      timeZone: "UTC",
      environment: "production",
      firstDay: day(6),
      lastDay: TODAY,
      previous: { firstDay: day(13), lastDay: day(7) },
      received: true,
      // Visitors 1, 2, 6 (u-old's visit yesterday); 4 pageviews.
      summary: { visitors: 3, visits: 3, pageviews: 4 },
      // Visitors 3 and 5, before noon on their days.
      previousSummary: { visitors: 2, visits: 2, pageviews: 2 },
    });
    expect(traffic.days).toHaveLength(7);
    expect(traffic.days.find((point: { day: string }) => point.day === day(1))).toEqual({
      day: day(1),
      visitors: 2,
    });
  });

  test("sources and pages: by visitors", async () => {
    const sources = await widget("sources");
    expect(sources.sources).toEqual([
      { value: "Direct / none", visitors: 2 },
      { value: "google.com", visitors: 1 },
    ]);
    expect(sources.pages).toEqual([
      { path: "/", visitors: 3 },
      { path: "/pricing", visitors: 1 },
    ]);
  });

  test("speed: the p75 per device in the environment, with the thresholds", async () => {
    expect(await widget("speed")).toMatchObject({
      received: true,
      thresholds: { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] },
      devices: [{ deviceType: "mobile", loads: 1, lcp: 4600, inp: 520, cls: 0.3 }],
    });
  });

  test("errors: occurrences against the period before, new and regressed groups, the top unresolved", async () => {
    const errors = await widget("errors");
    expect(errors).toMatchObject({
      received: true,
      occurrences: 3,
      previousOccurrences: 1,
      newGroups: 1,
      regressedGroups: 0,
      unresolvedGroups: 2,
      truncated: false,
    });
    // A reached one known user and two visitors; B one visitor.
    expect(errors.top).toEqual([
      expect.objectContaining({
        fingerprint: ERROR_A.fingerprint,
        users: 1,
        visitors: 2,
        occurrences: 2,
        isNew: false,
      }),
      expect.objectContaining({
        fingerprint: ERROR_B.fingerprint,
        users: 0,
        visitors: 1,
        occurrences: 1,
        isNew: true,
      }),
    ]);
  });

  test("services: requests, failures, and p95 per service, busiest first, with the period before", async () => {
    const services = await widget("services");
    expect(services).toEqual(
      expect.objectContaining({
        received: true,
        more: false,
        services: [
          {
            service: "web",
            requests: 3,
            failed: 1,
            // Interpolated: 20 + 0.9 × (30 − 20) ms.
            p95Us: 29_000,
            previous: { requests: 1, failed: 0, p95Us: 40_000 },
          },
          {
            service: "billing",
            requests: 1,
            failed: 0,
            p95Us: 2_000_000,
            previous: { requests: 0, failed: 0, p95Us: null },
          },
        ],
      }),
    );
  });

  test("AI cost: the estimated cost and calls against the period before, the models that cost the most", async () => {
    const answer = await widget("ai-cost");
    expect(answer).toEqual(
      expect.objectContaining({
        received: true,
        costUsd: expect.closeTo(2 * inputCost(SONNET, 1_000_000) + inputCost(MINI, 1_000_000), 9),
        calls: 4,
        noPriceCalls: 1,
        previousCostUsd: expect.closeTo(inputCost(SONNET, 500_000), 9),
        previousCalls: 1,
        // The model without a price costs nothing here, and is not listed.
        models: [
          { model: SONNET, costUsd: expect.closeTo(2 * inputCost(SONNET, 1_000_000), 9), calls: 2 },
          { model: MINI, costUsd: expect.closeTo(inputCost(MINI, 1_000_000), 9), calls: 1 },
        ],
      }),
    );
    // A project without AI calls says so.
    expect(await widget("ai-cost", { projectId: other.id })).toEqual(
      expect.objectContaining({
        received: false,
        costUsd: 0,
        calls: 0,
        models: [],
        previousCostUsd: 0,
        previousCalls: 0,
      }),
    );
  });

  test("users: active and new against the period before, and the cohorts", async () => {
    const users = await widget("users");
    expect(users).toMatchObject({
      received: true,
      active: 2,
      new: 1,
      previousActive: 1,
      previousNew: 0,
      previous: { firstDay: day(13), lastDay: day(7) },
      currentWeek: mondayOf(TODAY),
      newest: [{ userId: "u-new" }],
    });
    expect(users.cohorts).toHaveLength(6);
    expect(users.cohorts.at(-1).week).toBe(mondayOf(TODAY));
    // u-new's cohort: one user, active in its first week.
    const cohort = users.cohorts.find((item: { week: string }) => item.week === mondayOf(day(1)));
    expect(cohort.users).toBe(1);
    // A later week that has begun but is not over is marked current; one not begun is null.
    const thisWeek = users.cohorts.at(-1);
    const lastWeek = users.cohorts.at(-2);
    expect(thisWeek).toMatchObject({ week1: null, week4: null });
    expect(lastWeek.week1).toEqual({ users: expect.any(Number), current: true });
    expect(users.cohorts[0].week4).toEqual({ users: expect.any(Number), current: false });
    expect(users.cohorts[1].week4).toEqual({ users: expect.any(Number), current: true });
  });

  test("goals and the main goal: visitors, times, and conversion against the period before", async () => {
    const created = await send("POST", `/api/projects/${site.id}/goals`, {
      payload: { name: "Saw pricing", step: { type: "page", path: "/pricing" } },
    });
    const goalId = created.json().goal.id;
    const goals = await widget("goals");
    expect(goals).toMatchObject({
      mainGoalId: null,
      visitors: 3,
      previousVisitors: 2,
      goals: [
        {
          id: goalId,
          name: "Saw pricing",
          visitors: 1,
          events: 1,
          conversionRate: 1 / 3,
          previous: { visitors: 0, events: 0, conversionRate: 0 },
        },
      ],
    });
    // Without a main goal, the headline is new signed-in users.
    expect(await widget("main-goal")).toMatchObject({
      kind: "new_users",
      newUsers: 1,
      previousNewUsers: 0,
      received: true,
    });
    const patched = await send("PATCH", `/api/projects/${site.id}`, {
      payload: { mainGoalId: goalId },
    });
    expect(patched.json().project.mainGoalId).toBe(goalId);
    expect(await widget("main-goal")).toMatchObject({
      kind: "goal",
      visitors: 3,
      goal: { id: goalId, visitors: 1, conversionRate: 1 / 3 },
    });
    expect((await widget("goals")).mainGoalId).toBe(goalId);

    // Deleting the goal clears the main goal.
    await send("DELETE", `/api/projects/${site.id}/goals/${goalId}`);
    const project = await send("GET", `/api/projects/${site.id}`);
    expect(project.json().project.mainGoalId).toBeNull();
    expect((await widget("main-goal")).kind).toBe("new_users");
  });

  test("the main goal must be one of the project's goals", async () => {
    const elsewhere = await send("POST", `/api/projects/${other.id}/goals`, {
      payload: { name: "Signup", step: { type: "event", name: "signup" } },
    });
    const response = await send("PATCH", `/api/projects/${site.id}`, {
      payload: { mainGoalId: elsewhere.json().goal.id },
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: { error: "goal_not_found", message: "The project has no goal with this ID." },
    });
    expect(
      (await send("PATCH", `/api/projects/${site.id}`, { payload: { mainGoalId: null } }))
        .statusCode,
    ).toBe(200);
    // Deleting a project with a main goal deletes both.
    const third = await createProject("Third site");
    const kept = await send("POST", `/api/projects/${third.id}/goals`, {
      payload: { name: "Pricing", step: { type: "page", path: "/pricing" } },
    });
    await send("PATCH", `/api/projects/${third.id}`, {
      payload: { mainGoalId: kept.json().goal.id },
    });
    const deleted = await send("DELETE", `/api/projects/${third.id}`, {
      payload: { confirmName: "Third site" },
    });
    expect(deleted.statusCode).toBe(204);
    const left = await dashboard.db
      .selectFrom("goals")
      .select("id")
      .where("project_id", "=", third.id)
      .execute();
    expect(left).toEqual([]);
    expect(
      await dashboard.db.selectFrom("projects").select("id").where("id", "=", third.id).execute(),
    ).toEqual([]);
  });

  test("uptime and attention: checks, uptime over the period, incidents, and what fires now", async () => {
    const insertCheck = (name: string, values: object) =>
      dashboard.db
        .insertInto("uptime_checks")
        .values({
          project_id: site.id,
          name,
          url: `https://${name.toLowerCase()}.example/`,
          method: "GET",
          interval_seconds: 60,
          timeout_seconds: 10,
          expected_statuses: "200-399",
          word_mode: "present",
          failures_before_down: 2,
          next_due_at: NOW,
          created_at: new Date(NOW.getTime() - 40 * DAY_MS),
          ...values,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    // Empty first: nothing watched.
    expect(await widget("attention")).toMatchObject({
      alerts: [],
      down: [],
      certificates: [],
      checks: { total: 0, up: 0, paused: 0 },
      rules: 0,
    });
    const home = await insertCheck("Home", {
      state: "up",
      last_response_ms: 123,
      // Expires in three days: within the 14 a certificate rule warns by default.
      tls_expires_at: new Date(NOW.getTime() + 3 * DAY_MS),
    });
    const api = await insertCheck("Api", {
      state: "down",
      failing_since: new Date(NOW.getTime() - 2 * 3_600_000),
      failing_cause: "status",
      last_status_code: 503,
      last_response_ms: 48,
    });
    // Api was down for 12 hours four days ago, and is down since two hours ago.
    await dashboard.db
      .insertInto("uptime_incidents")
      .values([
        {
          check_id: api.id,
          project_id: site.id,
          cause: "status",
          started_at: at(4, "00:00"),
          ended_at: at(4, "12:00"),
        },
        {
          check_id: api.id,
          project_id: site.id,
          cause: "status",
          started_at: new Date(NOW.getTime() - 2 * 3_600_000),
          ended_at: null,
        },
      ])
      .execute();

    const uptime = await widget("uptime");
    // The period so far: six days and twelve hours, 156 hours; down 14 of them.
    // By name: Api, then Home.
    expect(uptime.checks).toEqual([
      expect.objectContaining({ id: api.id, state: "down", incidents: 2, previousUptime: 1 }),
      expect.objectContaining({
        id: home.id,
        state: "up",
        uptime: 1,
        incidents: 0,
        lastResponseMs: 123,
      }),
    ]);
    expect(uptime.checks[0].uptime).toBeCloseTo(1 - 14 / 156, 6);

    const attention = await widget("attention");
    expect(attention).toMatchObject({
      alerts: [],
      down: [{ checkId: api.id, name: "Api", cause: "status", statusCode: 503 }],
      certificates: [{ checkId: home.id, name: "Home", expired: false }],
      checks: { total: 2, up: 1, paused: 0 },
    });

    // A certificate already past its date has expired, not about to.
    await dashboard.db
      .updateTable("uptime_checks")
      .set({ tls_expires_at: new Date(NOW.getTime() - DAY_MS) })
      .where("id", "=", home.id)
      .execute();
    expect((await widget("attention")).certificates).toEqual([
      expect.objectContaining({ checkId: home.id, expired: true }),
    ]);
  });
});

describe("who reaches which widget", () => {
  test("each widget's route needs its area: 403 without it, 404 on a project not granted", async () => {
    const { cookie } = await member("nothing@example.com", {});
    for (const name of Object.keys(WIDGET_AREAS)) {
      const refused = await send("GET", `/api/projects/${site.id}/overview/${name}`, { cookie });
      expect({ name, status: refused.statusCode, body: refused.json() }).toEqual({
        name,
        status: 403,
        body: FORBIDDEN,
      });
      const unknown = await send("GET", `/api/projects/${other.id}/overview/${name}`, { cookie });
      expect({ name, status: unknown.statusCode, body: unknown.json() }).toEqual({
        name,
        status: 404,
        body: NOT_FOUND,
      });
    }
    // The layout needs only the project: with no area, it holds no widget.
    expect(
      (await send("GET", `/api/projects/${site.id}/overview/layout`, { cookie })).json(),
    ).toEqual({
      widgets: [],
      isDefault: true,
    });
  });

  test("a member with only web analytics reaches speed, traffic, and sources, and no other widget", async () => {
    const { cookie } = await member("web-only@example.com", { web_analytics: "view" });
    const statuses: Record<string, number> = {};
    for (const name of Object.keys(WIDGET_AREAS)) {
      const response = await send("GET", `/api/projects/${site.id}/overview/${name}`, { cookie });
      statuses[name] = response.statusCode;
    }
    expect(statuses).toEqual({
      attention: 403,
      errors: 403,
      uptime: 403,
      services: 403,
      "ai-cost": 403,
      speed: 200,
      "main-goal": 403,
      traffic: 200,
      goals: 403,
      users: 403,
      sources: 200,
    });
    const layout = (
      await send("GET", `/api/projects/${site.id}/overview/layout`, { cookie })
    ).json();
    expect(layout.widgets.map((item: { id: string }) => item.id)).toEqual([
      "speed",
      "traffic",
      "sources",
    ]);
  });

  test("the users widget names no user without the users area", async () => {
    const { cookie } = await member("product-only@example.com", { product_analytics: "view" });
    const users = await widget("users", { cookie });
    expect(users.newest).toBeNull();
    expect(JSON.stringify(users)).not.toContain("u-new");
    expect(JSON.stringify(users)).not.toContain("u-old");
    const { cookie: withUsers } = await member("product-users@example.com", {
      product_analytics: "view",
      users: "view",
    });
    expect((await widget("users", { cookie: withUsers })).newest).toEqual([
      { userId: "u-new", firstSeenAt: at(1, "10:02").toISOString() },
    ]);
  });

  test("firing alerts show only the kinds the user may see", async () => {
    const channel = await send("POST", "/api/channels", {
      payload: { kind: "email", addresses: ["ops@example.com"] },
    });
    const rule = async (body: object) =>
      (
        await send("POST", `/api/projects/${site.id}/alert-rules`, {
          payload: { ...body, channelIds: [channel.json().channel.id] },
        })
      ).json().rule.id as string;
    const errorRule = await rule({ kind: "error_new", name: "New errors" });
    const checkRule = await rule({ kind: "check_down", name: "API down" });
    for (const [ruleId, kind] of [
      [errorRule, "error_new"],
      [checkRule, "check_down"],
    ] as const) {
      const history = await dashboard.db
        .insertInto("alert_history")
        .values({
          rule_id: ruleId,
          project_id: site.id,
          kind,
          subject: ruleId,
          subject_name: "Subject",
          fired_at: NOW,
          message: "Firing",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await dashboard.db
        .insertInto("alert_states")
        .values({
          rule_id: ruleId,
          subject: ruleId,
          firing: true,
          since: NOW,
          history_id: history.id,
        })
        .execute();
    }
    expect(names(await widget("attention"))).toEqual(["API down", "New errors"]);
    const { cookie } = await member("uptime-only@example.com", { uptime_alerts: "view" });
    expect(names(await widget("attention", { cookie }))).toEqual(["API down"]);

    // The rules counted are those on, of kinds the user may see.
    expect((await widget("attention")).rules).toBe(2);
    expect((await widget("attention", { cookie })).rules).toBe(1);
    await send("PATCH", `/api/projects/${site.id}/alert-rules/${checkRule}`, {
      payload: { enabled: false },
    });
    expect((await widget("attention")).rules).toBe(1);
    expect((await widget("attention", { cookie })).rules).toBe(0);
  });
});

describe("each user's own layout", () => {
  test("saves, isolates per user and project, and resets", async () => {
    const defaults = (await send("GET", layoutUrl(site.id))).json();
    expect(defaults).toEqual({
      widgets: WIDGET_IDS.map((id) => ({ id, hidden: false })),
      isDefault: true,
    });

    // Traffic moved first, errors hidden.
    const order = ["traffic", ...WIDGET_IDS.filter((id) => id !== "traffic")];
    const saved = await send("PUT", layoutUrl(site.id), { payload: { order, hidden: ["errors"] } });
    expect(saved.statusCode).toBe(200);
    expect(ids(saved.json())).toEqual(order.map((id) => (id === "errors" ? "-errors" : id)));
    expect((await send("GET", layoutUrl(site.id))).json()).toEqual(saved.json());
    expect(saved.json().isDefault).toBe(false);

    // Another project, and another user, keep the default.
    expect((await send("GET", layoutUrl(other.id))).json().isDefault).toBe(true);
    const admin = await signedInUser(dashboard, {
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
    });
    expect((await send("GET", layoutUrl(site.id), { cookie: admin.cookie })).json().isDefault).toBe(
      true,
    );

    // Unknown widgets are refused; changes need the dashboard's origin.
    expect(
      (await send("PUT", layoutUrl(site.id), { payload: { order: ["nope"], hidden: [] } }))
        .statusCode,
    ).toBe(400);
    const elsewhere = await dashboard.app.inject({
      method: "DELETE",
      url: layoutUrl(site.id),
      headers: { cookie: dashboard.cookie, origin: "https://elsewhere.example" },
    });
    expect(elsewhere.statusCode).toBe(403);

    const reset = await send("DELETE", layoutUrl(site.id));
    expect(reset.json()).toEqual(defaults);
    expect((await send("GET", layoutUrl(site.id))).json()).toEqual(defaults);
  });

  test("a member's saved layout keeps the place of widgets they cannot see", async () => {
    const { userId, cookie } = await member("layout@example.com", {
      web_analytics: "view",
      errors: "view",
    });
    const url = `/api/projects/${site.id}/overview/layout`;
    await send("PUT", url, {
      cookie,
      payload: { order: ["sources", "errors", "speed", "traffic"], hidden: ["speed"] },
    });
    // Granted product analytics later: its widgets appear in their default places.
    await dashboard.db
      .updateTable("dashboard_member_access")
      .set({ product_analytics: "view" })
      .where("user_id", "=", userId)
      .execute();
    const layout = (await send("GET", url, { cookie })).json();
    expect(layout.widgets).toEqual([
      { id: "sources", hidden: false },
      { id: "errors", hidden: false },
      { id: "speed", hidden: true },
      { id: "main-goal", hidden: false },
      { id: "traffic", hidden: false },
      { id: "goals", hidden: false },
      { id: "users", hidden: false },
    ]);
  });

  test("a stored order is completed with every widget, in its default place", () => {
    expect(completeOrder([])).toEqual(WIDGET_IDS);
    expect(completeOrder(["sources", "unknown", "sources", "attention"])).toEqual([
      "sources",
      "attention",
      "errors",
      "uptime",
      "services",
      "ai-cost",
      "speed",
      "main-goal",
      "traffic",
      "goals",
      "users",
    ]);
  });
});

test("the owner's areas reach every widget", () => {
  expect(Object.values(WIDGET_AREAS).every((area) => ALL_AREAS[area] !== "none")).toBe(true);
});

/** A moment as ClickHouse writes a DateTime64(3) in UTC. */
const time = (moment: Date) => moment.toISOString().replace("T", " ").replace("Z", "");

describe("first-seen times", () => {
  test("follow the events: kept as they arrive, gone with old events and with the project", async () => {
    const project = await createProject("First seen");
    await dashboard.store(project.id, [
      event("pageview", at(40, "09:00"), { path: "/", visitorId: "1", userId: "early" }),
      event("pageview", at(1, "09:00"), { path: "/", visitorId: "2", userId: "early" }),
      event("pageview", at(1, "09:30"), { path: "/", visitorId: "3", userId: "late" }),
    ]);
    const firstSeen = async () => {
      const result = await dashboard.reader.client.query({
        query: `SELECT user_id, minMerge(first_seen) AS first_seen FROM user_first_seen
                WHERE project_id = {project:UUID} GROUP BY user_id ORDER BY user_id`,
        query_params: { project: project.id },
        format: "JSONEachRow",
      });
      return result.json<{ user_id: string; first_seen: string }>();
    };
    expect(await firstSeen()).toEqual([
      {
        user_id: "early",
        first_seen: at(40, "09:00").toISOString().replace("T", " ").replace("Z", ""),
      },
      {
        user_id: "late",
        first_seen: at(1, "09:30").toISOString().replace("T", " ").replace("Z", ""),
      },
    ]);
    // "early" is not new in the period: their first event was 40 days ago.
    expect(await widget("main-goal", { projectId: project.id })).toMatchObject({
      kind: "new_users",
      newUsers: 1,
    });

    // Keeping 30 days deletes the first event: "early" is first seen at the next.
    await dashboard.db
      .updateTable("projects")
      .set({ retention_days: 30 })
      .where("id", "=", project.id)
      .execute();
    await deleteExpiredEvents(dashboard.db, dashboard.reader.client, { now: NOW });
    expect((await firstSeen()).map((row) => row.user_id)).toEqual(["early", "late"]);
    expect((await firstSeen())[0]?.first_seen).toBe(
      at(1, "09:00").toISOString().replace("T", " ").replace("Z", ""),
    );

    // Deleting the project deletes its first-seen times with its events.
    await send("DELETE", `/api/projects/${project.id}`, { payload: { confirmName: "First seen" } });
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);
    expect(await firstSeen()).toEqual([]);
  });

  test("short of disk, a rebuild removes nothing, is marked, and runs once there is room", async () => {
    const project = await createProject("First seen, full disk");
    await dashboard.store(project.id, [
      event("pageview", at(40, "09:00"), { path: "/", visitorId: "1", userId: "early" }),
      event("pageview", at(1, "09:00"), { path: "/", visitorId: "2", userId: "early" }),
    ]);
    const firstSeenOf = async () => {
      const result = await dashboard.reader.client.query({
        query: `SELECT user_id, minMerge(first_seen) AS first_seen FROM user_first_seen
                WHERE project_id = {project:UUID} GROUP BY user_id ORDER BY user_id`,
        query_params: { project: project.id },
        format: "JSONEachRow",
      });
      return result.json<{ user_id: string; first_seen: string }>();
    };
    const marks = () =>
      dashboard.db
        .selectFrom("first_seen_rebuilds")
        .select("project_id")
        .where("project_id", "=", project.id)
        .execute();
    await dashboard.db
      .updateTable("projects")
      .set({ retention_days: 30 })
      .where("id", "=", project.id)
      .execute();

    // 6% free: under the 7% a rebuild needs. The old events go; the first-seen times stay.
    const full = { freeRatio: async () => 0.06 };
    await deleteExpiredEvents(dashboard.db, dashboard.reader.client, { now: NOW, room: full });
    expect(await firstSeenOf()).toEqual([{ user_id: "early", first_seen: time(at(40, "09:00")) }]);
    expect(await marks()).toEqual([{ project_id: project.id }]);
    // Still no room: the worker's retry waits too.
    expect(await retryFirstSeenRebuilds(dashboard.db, dashboard.reader.client, full)).toMatchObject(
      {
        outcome: "deferred",
      },
    );
    expect(await marks()).toHaveLength(1);

    // Room again: the worker's retry works them out, and the mark goes.
    const roomy = { freeRatio: async () => 0.5 };
    expect(
      await retryFirstSeenRebuilds(dashboard.db, dashboard.reader.client, roomy),
    ).toMatchObject({
      outcome: "rebuilt",
    });
    expect(await firstSeenOf()).toEqual([{ user_id: "early", first_seen: time(at(1, "09:00")) }]);
    expect(await marks()).toEqual([]);
    // The real disk (the development server has room): nothing left to do.
    expect(await retryFirstSeenRebuilds(dashboard.db, dashboard.reader.client)).toEqual({
      projects: 0,
      outcome: "none",
    });
  });
});

test("error occurrences and new groups are counted in full, past the list's 1,000 groups", async () => {
  const project = await createProject("Many errors");
  await dashboard.store(
    project.id,
    Array.from({ length: 1002 }, (_, index) =>
      event("error", at(1, "10:00"), {
        path: "/",
        visitorId: "1",
        error: {
          type: "Error",
          message: `Error ${index}`,
          handled: false,
          fingerprint: `1-${String(index).padStart(20, "0")}`,
        },
      }),
    ),
  );
  const errors = await widget("errors", { projectId: project.id });
  expect(errors).toMatchObject({
    truncated: true,
    occurrences: 1002,
    newGroups: 1002,
    unresolvedGroups: 1000,
  });
});

test("two saves at once: each waits for the other, and the last wins whole", async () => {
  const project = await createProject("Layouts at once");
  const url = layoutUrl(project.id);
  const first = ["sources", ...WIDGET_IDS.filter((id) => id !== "sources")];
  const second = ["traffic", ...WIDGET_IDS.filter((id) => id !== "traffic")];
  const answers = await Promise.all([
    send("PUT", url, { payload: { order: first, hidden: ["errors"] } }),
    send("PUT", url, { payload: { order: second, hidden: [] } }),
  ]);
  expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200]);
  const stored = ids((await send("GET", url)).json());
  expect([first.map((id) => (id === "errors" ? "-errors" : id)), second]).toContainEqual(stored);
});
