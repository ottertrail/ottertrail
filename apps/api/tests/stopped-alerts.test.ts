import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { AlertContext } from "../src/alerts/fire.ts";
import type { RuleKind, StoppedSettings } from "../src/alerts/kinds.ts";
import { arrivedCount } from "../src/alerts/stopped-rules.ts";
import {
  evaluateTelemetryPass,
  evaluateTelemetryRule,
  takeDueRules,
  telemetryRules,
} from "../src/alerts/telemetry-rules.ts";
import { insertRows } from "../src/clickhouse/insert.ts";
import { clickHouseTime } from "../src/clickhouse/query.ts";
import { isPayload, type NotificationPayload } from "../src/notifications/events.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/**
 * "Data stops arriving" rules (docs/uptime-alerts.md, "Alerts on data that stops arriving"):
 * each source counted by arrival, the new rule's first window, the filters, project isolation,
 * the messages, the routes' checks, and who sees the rules and their alerts.
 */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let context: AlertContext;
let channelId = "";
let projectId = "";
let otherId = "";

const PUBLIC = "https://ottertrail.example.com";
const MINUTE = 60_000;
/** The evaluations' clock: a whole minute, two hours ago. */
const AT = new Date(Math.floor((Date.now() - 2 * 60 * MINUTE) / MINUTE) * MINUTE);
const after = (minutes: number) => new Date(AT.getTime() + minutes * MINUTE);
const time = (moment: Date) => clickHouseTime(moment);

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
  projectId = (await insertProject(dashboard.db, { name: "Main site" })).id;
  otherId = (await insertProject(dashboard.db, { name: "Other site" })).id;
});

const settingsOf = (settings: Partial<StoppedSettings>): StoppedSettings => ({
  source: "events",
  environment: "production",
  eventName: null,
  service: null,
  metric: null,
  host: null,
  windowMinutes: 30,
  minCount: 1,
  ...settings,
});

async function insertRule(
  kind: RuleKind,
  settings: Partial<StoppedSettings>,
  activeSince: Date = after(-120),
) {
  const row = await dashboard.db
    .insertInto("alert_rules")
    .values({
      project_id: projectId,
      name: "Data stops arriving",
      kind,
      settings: JSON.stringify(settingsOf(settings)),
      channel_ids: [channelId],
      active_since: activeSince,
      created_at: activeSince,
      updated_at: activeSince,
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

interface Arrival {
  /** When it happened; when it arrived when left out. */
  at?: Date;
  arrived: Date;
  project?: string;
  environment?: string;
}

async function events(rows: (Arrival & { name?: string })[]) {
  await insertRows(
    dashboard.reader.client,
    "events",
    rows.map((row) => ({
      project_id: row.project ?? projectId,
      event_id: randomUUID(),
      name: row.name ?? "pageview",
      occurred_at: time(row.at ?? row.arrived),
      received_at: time(row.arrived),
      path: "/",
      properties: "{}",
      environment: row.environment ?? "production",
    })),
  );
}

async function spans(rows: (Arrival & { service?: string })[]) {
  await insertRows(
    dashboard.reader.client,
    "spans",
    rows.map((row) => ({
      project_id: row.project ?? projectId,
      timestamp: time(row.at ?? row.arrived),
      received_at: time(row.arrived),
      id: randomUUID(),
      trace_id: randomUUID().replaceAll("-", ""),
      span_id: randomUUID().replaceAll("-", "").slice(0, 16),
      name: "GET /",
      kind: "server",
      status_code: "ok",
      service: row.service ?? "api",
      environment: row.environment ?? "production",
    })),
  );
}

async function logs(rows: (Arrival & { service?: string })[]) {
  await insertRows(
    dashboard.reader.client,
    "logs",
    rows.map((row) => ({
      project_id: row.project ?? projectId,
      timestamp: time(row.at ?? row.arrived),
      observed_timestamp: time(row.at ?? row.arrived),
      received_at: time(row.arrived),
      id: randomUUID(),
      body: "started",
      service: row.service ?? "api",
      environment: row.environment ?? "production",
    })),
  );
}

async function points(rows: (Arrival & { name: string; host?: string; histogram?: boolean })[]) {
  for (const row of rows) {
    const common = {
      project_id: row.project ?? projectId,
      timestamp: time(row.at ?? row.arrived),
      start_timestamp: time(row.at ?? row.arrived),
      received_at: time(row.arrived),
      id: randomUUID(),
      name: row.name,
      service: "api",
      environment: row.environment ?? "production",
      resource_attributes: row.host === undefined ? {} : { "host.name": row.host },
    };
    // eslint-disable-next-line no-await-in-loop -- a few rows, each to its own table
    await insertRows(
      dashboard.reader.client,
      row.histogram === true ? "metric_histograms" : "metric_points",
      [
        row.histogram === true
          ? { ...common, temporality: "delta", count: 1, bounds: [1], bucket_counts: [1, 0] }
          : { ...common, kind: "gauge", value: 1 },
      ],
    );
  }
}

describe("events", () => {
  test("fires when nothing arrived in the window, and resolves when events arrive again", async () => {
    const ruleId = await insertRule("events_stopped", {});
    // Arrived before the window (AT - 30 s - 30 min): not counted.
    await events([{ arrived: after(-31) }]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 0 } });
    expect(await evaluate(ruleId, after(1))).toMatchObject({ outcome: "none" });
    await events([{ arrived: after(1) }]);
    expect(await evaluate(ruleId, after(2))).toMatchObject({
      outcome: "sent",
      reading: { value: 1 },
    });
    const [fired, resolved] = await sent();
    expect(fired).toMatchObject({
      type: "data.stopped",
      message: "No events from Main site in production in the last 30 minutes.",
      url: `${PUBLIC}/projects/${projectId}/alerts/${ruleId}`,
      subject: {
        type: "data_stopped",
        source: "events",
        environment: "production",
        eventName: null,
        windowMinutes: 30,
        minCount: 1,
        count: 0,
        ruleId,
      },
    });
    expect(resolved).toMatchObject({
      type: "data.stopped_resolved",
      message: "Events arrive again from Main site in production.",
    });
    const history = await dashboard.db
      .selectFrom("alert_history")
      .select(["kind", "subject_name", "resolved_at"])
      .where("rule_id", "=", ruleId)
      .execute();
    expect(history).toEqual([
      { kind: "events_stopped", subject_name: "Events", resolved_at: expect.any(Date) },
    ]);
  });

  test("counts by arrival: a late event counts, one that arrived before the window does not", async () => {
    const ruleId = await insertRule("events_stopped", { windowMinutes: 5 });
    // Happened in the window, but arrived before it.
    await events([{ at: after(-2), arrived: after(-6) }]);
    expect((await evaluate(ruleId, AT)).outcome).toBe("sent");
    // Happened 20 hours ago, arrived now: data still arrives.
    await events([{ at: after(-20 * 60), arrived: after(0) }]);
    expect(await evaluate(ruleId, after(1))).toMatchObject({
      outcome: "sent",
      reading: { value: 1 },
    });
  });

  test("fires below N, counts one event name, and words the count", async () => {
    const ruleId = await insertRule("events_stopped", {
      eventName: "waitlist_signup",
      minCount: 3,
      windowMinutes: 60,
    });
    await events([
      { name: "waitlist_signup", arrived: after(-50) },
      { name: "waitlist_signup", arrived: after(-10) },
      // Other names, an error, and Web Vitals are not counted.
      ...Array.from({ length: 5 }, () => ({ name: "pageview", arrived: after(-5) })),
      { name: "vitals", arrived: after(-5) },
    ]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 2 } });
    await events([{ name: "waitlist_signup", arrived: after(0) }]);
    expect(await evaluate(ruleId, after(1))).toMatchObject({
      outcome: "sent",
      reading: { value: 3 },
    });
    expect((await sent()).map((payload) => payload.message)).toEqual([
      "Only 2 events named waitlist_signup from Main site in production in the last 1 hour, fewer than the rule's 3.",
      "Events named waitlist_signup arrive again from Main site in production. At least 3 arrived in the last 1 hour.",
    ]);
  });

  test("a new rule waits a whole window before it judges", async () => {
    // Added 10 minutes before the evaluation, with a 30-minute window.
    const ruleId = await insertRule("events_stopped", {}, after(-10));
    expect(await evaluate(ruleId, AT)).toMatchObject({
      outcome: "none",
      reading: { value: null },
    });
    // 30 minutes and 30 seconds after it was added, the window is its own.
    expect((await evaluate(ruleId, after(20))).outcome).toBe("none");
    expect((await evaluate(ruleId, after(21))).outcome).toBe("sent");
  });

  test("counts only the project's events, in the rule's environment", async () => {
    const ruleId = await insertRule("events_stopped", { environment: "staging" });
    await events([
      { arrived: after(-5), project: otherId, environment: "staging" },
      { arrived: after(-5) },
    ]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 0 } });
    await events([{ arrived: after(-4), environment: "staging" }]);
    expect(await evaluate(ruleId, after(1))).toMatchObject({ reading: { value: 1 } });
  });
});

describe("telemetry", () => {
  test("traces: one service's spans, by arrival", async () => {
    const ruleId = await insertRule("telemetry_stopped", { source: "traces", service: "api" });
    await spans([
      { arrived: after(-5), service: "worker" },
      { arrived: after(-5), project: otherId },
      // Happened in the window, arrived before it.
      { at: after(-10), arrived: after(-40) },
    ]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 0 } });
    await spans([{ at: after(-30), arrived: after(1) }]);
    expect((await evaluate(ruleId, after(2))).outcome).toBe("sent");
    expect((await sent()).map((payload) => payload.message)).toEqual([
      "No spans of the service api from Main site in production in the last 30 minutes.",
      "Spans of the service api arrive again from Main site in production.",
    ]);
  });

  test("logs: every service's records unless one is named", async () => {
    const all = await insertRule("telemetry_stopped", { source: "logs", windowMinutes: 10 });
    const worker = await insertRule("telemetry_stopped", {
      source: "logs",
      service: "worker",
      windowMinutes: 10,
    });
    await logs([{ arrived: after(-3), service: "api" }]);
    expect((await evaluate(all, AT)).outcome).toBe("none");
    expect(await evaluate(worker, AT)).toMatchObject({ outcome: "sent", reading: { value: 0 } });
    expect((await sent())[0]?.message).toBe(
      "No log records of the service worker from Main site in production in the last 10 minutes.",
    );
  });

  test("metrics: one metric's points and histograms, on one host", async () => {
    const ruleId = await insertRule("telemetry_stopped", {
      source: "metrics",
      metric: "queue.depth",
      host: "web-1",
      windowMinutes: 15,
      minCount: 2,
    });
    await points([
      { name: "queue.depth", host: "web-1", arrived: after(-3) },
      { name: "queue.depth", host: "web-2", arrived: after(-3) },
      { name: "queue.size", host: "web-1", arrived: after(-3) },
    ]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 1 } });
    await points([{ name: "queue.depth", host: "web-1", arrived: after(0), histogram: true }]);
    expect(await evaluate(ruleId, after(1))).toMatchObject({
      outcome: "sent",
      reading: { value: 2 },
    });
    expect((await sent()).map((payload) => payload.message)).toEqual([
      "Only 1 points of the metric queue.depth on the host web-1 from Main site in production in the last 15 minutes, fewer than the rule's 2.",
      "Points of the metric queue.depth on the host web-1 arrive again from Main site in production. At least 2 arrived in the last 15 minutes.",
    ]);
  });

  test("the worker's pass takes and evaluates them with the other telemetry rules", async () => {
    const ruleId = await insertRule("telemetry_stopped", { source: "traces" });
    const taken = await takeDueRules(dashboard.db, AT);
    expect(taken.map((rule) => rule.id)).toContain(ruleId);
    const { results } = await evaluateTelemetryPass(context, taken, {
      readerOf: () => dashboard.reader,
      now: () => AT,
    });
    expect(results).toContainEqual({
      rule: expect.objectContaining({ id: ruleId }),
      result: expect.objectContaining({ outcome: "sent" }),
    });
  });

  test("a rule's query reads a bounded number of rows", async () => {
    // Two days of a busy project's spans, a span every 2 seconds: 86,400 rows.
    await dashboard.reader.client.command({
      query: `INSERT INTO spans (project_id, timestamp, received_at, id, service, environment)
              SELECT {project:UUID}, ts, ts, toString(number), 'api', 'production'
              FROM (SELECT number, toDateTime64({end:String}, 9, 'UTC')
                      - toIntervalSecond(number * 2) AS ts FROM numbers(86400))`,
      query_params: { project: projectId, end: time(after(0)) },
    });
    const settings = settingsOf({ source: "traces", service: "worker", windowMinutes: 30 });
    const window = { from: after(-30), to: after(0) };
    expect(await arrivedCount(dashboard.reader, projectId, settings, window, 1)).toBe(0);
    // With data, LIMIT stops the read early.
    expect(
      await arrivedCount(dashboard.reader, projectId, { ...settings, service: "api" }, window, 1),
    ).toBe(1);
    await dashboard.reader.client.command({ query: "SYSTEM FLUSH LOGS" });
    const reads = await (
      await dashboard.reader.client.query({
        query: `SELECT read_rows FROM system.query_log
                WHERE type = 'QueryFinish' AND current_database = currentDatabase()
                  AND query LIKE '%received_at >%' AND query NOT LIKE '%query_log%'
                ORDER BY event_time_microseconds DESC
                LIMIT 2`,
        format: "JSONEachRow",
      })
    ).json<{ read_rows: string }>();
    // Nothing of the service: the window and the hour before it, in whole granules of 8,192,
    // not the two days. Data of the service: a granule or so.
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(Number(read.read_rows)).toBeLessThanOrEqual(3 * 8192);
  });
});

function api(cookie: string, method: "POST" | "GET" | "PATCH", path: string, payload?: object) {
  return dashboard.app.inject({
    method,
    url: `/api${path}`,
    headers: { cookie, origin: PUBLIC_URL },
    ...(payload === undefined ? {} : { payload }),
  });
}
const rules = (path = "") => `/projects/${projectId}/alert-rules${path}`;
const refused = async (body: object) => {
  const response = await api(dashboard.cookie, "POST", rules(), {
    channelIds: [channelId],
    ...body,
  });
  expect(response.statusCode).toBe(400);
  const answer = response.json<{ error: string; code?: string }>();
  return answer.code ?? answer.error;
};

describe("the rule routes", () => {
  test("save with defaults, and warn when nothing has arrived in the last day", async () => {
    const created = await api(dashboard.cookie, "POST", rules(), {
      kind: "events_stopped",
      settings: {},
      channelIds: [channelId],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      rule: expect.objectContaining({
        name: "Data stops arriving",
        kind: "events_stopped",
        settings: {
          source: "events",
          environment: "production",
          eventName: null,
          service: null,
          metric: null,
          host: null,
          windowMinutes: 60,
          minCount: 1,
        },
      }),
      warning: {
        reason: "not_seen",
        message:
          "No events arrived in production in the last 24 hours. The rule is saved, and fires once it is a window old unless they arrive.",
      },
    });
    await spans([{ arrived: new Date(Date.now() - MINUTE), service: "api" }]);
    const traces = await api(dashboard.cookie, "POST", rules(), {
      kind: "telemetry_stopped",
      settings: { source: "traces", service: "api", windowMinutes: 1440, minCount: 100 },
      channelIds: [channelId],
    });
    expect(traces.json()).toMatchObject({
      rule: { settings: { source: "traces", service: "api", windowMinutes: 1440, minCount: 100 } },
      warning: null,
    });
    // Another source drops the fields it does not take.
    const changed = await api(dashboard.cookie, "PATCH", rules(`/${traces.json().rule.id}`), {
      settings: { source: "metrics", metric: "queue.depth", host: "web-1" },
    });
    expect(changed.json().rule.settings).toEqual({
      source: "metrics",
      environment: "production",
      eventName: null,
      service: null,
      metric: "queue.depth",
      host: "web-1",
      windowMinutes: 1440,
      minCount: 100,
    });
  });

  test("refuse settings the kinds do not take", async () => {
    expect(await refused({ kind: "events_stopped", settings: { source: "logs" } })).toBe(
      "invalid_source",
    );
    expect(await refused({ kind: "telemetry_stopped", settings: { source: "events" } })).toBe(
      "invalid_source",
    );
    expect(await refused({ kind: "events_stopped", settings: { windowMinutes: 45 } })).toBe(
      "invalid_window",
    );
    expect(await refused({ kind: "events_stopped", settings: { windowMinutes: 1441 } })).toBe(
      "FST_ERR_VALIDATION",
    );
    expect(await refused({ kind: "events_stopped", settings: { minCount: 0 } })).toBe(
      "FST_ERR_VALIDATION",
    );
    expect(await refused({ kind: "events_stopped", settings: { eventName: "a\u0001" } })).toBe(
      "FST_ERR_VALIDATION",
    );
    expect(await refused({ kind: "telemetry_stopped", settings: { source: "metrics" } })).toBe(
      "invalid_metric",
    );
    // A day is this kind's alone.
    expect(await refused({ kind: "error_spike", settings: { windowMinutes: 120 } })).toBe(
      "invalid_window",
    );
    expect(
      await refused({ kind: "route_latency", settings: { service: null, thresholdMs: 5 } }),
    ).toBe("invalid_service");
  });
});

/** A member who manages alerts, with `areas` at view. */
const member = (email: string, areas: Record<string, "view">) =>
  signedInUser(dashboard, {
    name: email,
    email,
    grants: { projects: "all", areas: { uptime_alerts: "manage", ...areas } },
  });

describe("access", () => {
  test("events rules show to web or product analytics, telemetry rules to monitoring; so do their alerts", async () => {
    const web = await member(`web-${randomUUID()}@example.com`, { web_analytics: "view" });
    const product = await member(`product-${randomUUID()}@example.com`, {
      product_analytics: "view",
    });
    const monitoring = await member(`monitoring-${randomUUID()}@example.com`, {
      monitoring: "view",
    });
    const now = new Date();
    const eventsRule = await insertRule("events_stopped", {}, new Date(now.getTime() - 3600_000));
    const tracesRule = await insertRule(
      "telemetry_stopped",
      { source: "traces" },
      new Date(now.getTime() - 3600_000),
    );
    for (const ruleId of [eventsRule, tracesRule]) {
      // eslint-disable-next-line no-await-in-loop -- one alert after another
      expect((await evaluate(ruleId, now)).outcome).toBe("sent");
    }
    const kindsOf = async (cookie: string) =>
      (await api(cookie, "GET", rules())).json().rules.map((rule: { kind: string }) => rule.kind);
    const inbox = async (cookie: string) =>
      (await api(cookie, "GET", "/notifications"))
        .json()
        .notifications.map((item: { title: string }) => item.title);
    for (const { cookie } of [web, product]) {
      // eslint-disable-next-line no-await-in-loop -- one reader after another
      expect(await kindsOf(cookie)).toEqual(["events_stopped"]);
      // eslint-disable-next-line no-await-in-loop -- one reader after another
      expect(await inbox(cookie)).toEqual(["Data stopped arriving: Data stops arriving"]);
      // eslint-disable-next-line no-await-in-loop -- one reader after another
      expect((await api(cookie, "GET", rules(`/${tracesRule}`))).statusCode).toBe(404);
      expect(
        // eslint-disable-next-line no-await-in-loop -- one reader after another
        (
          await api(cookie, "POST", rules(), {
            kind: "telemetry_stopped",
            settings: { source: "logs" },
            channelIds: [channelId],
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(await kindsOf(monitoring.cookie)).toEqual(["telemetry_stopped"]);
    expect(await inbox(monitoring.cookie)).toEqual(["Data stopped arriving: Data stops arriving"]);
    expect((await api(monitoring.cookie, "GET", rules(`/${eventsRule}`))).statusCode).toBe(404);
    expect(
      (
        await api(monitoring.cookie, "POST", rules(), {
          kind: "events_stopped",
          channelIds: [channelId],
        })
      ).statusCode,
    ).toBe(403);
    const alerts = (await api(monitoring.cookie, "GET", `/projects/${projectId}/alerts`)).json()
      .alerts;
    expect(alerts.map((alert: { kind: string }) => alert.kind)).toEqual(["telemetry_stopped"]);
    // A product analytics reader adds an events rule, and hears whether events arrived.
    const created = await api(product.cookie, "POST", rules(), {
      kind: "events_stopped",
      channelIds: [channelId],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().warning).not.toBeNull();
  });
});
