import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { AlertContext } from "../src/alerts/fire.ts";
import type { LogLineSettings } from "../src/alerts/kinds.ts";
import { matchingLines, matchingLinesQuery } from "../src/alerts/log-rules.ts";
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
 * "Log lines match" rules (docs/uptime-alerts.md, "Alerts on matching log lines"): the Logs
 * page's filters counted by arrival, firing above N and resolving, project isolation, the count's
 * cap, the text index, the rows read, the messages and their link, the routes' checks, and who
 * sees the rules and their alerts. Also the Logs page's time window, which the link opens.
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
/** A body that holds personal data: no message may carry it. */
const PRIVATE_BODY = "Payment failed for alice@example.com: card 4242 declined";

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

const settingsOf = (settings: Partial<LogLineSettings>): LogLineSettings => ({
  environment: "production",
  service: "server",
  severity: "error",
  search: null,
  windowMinutes: 5,
  maxCount: 0,
  ...settings,
});

async function insertRule(settings: Partial<LogLineSettings>, activeSince: Date = after(-120)) {
  const row = await dashboard.db
    .insertInto("alert_rules")
    .values({
      project_id: projectId,
      name: "Server errors",
      kind: "log_lines",
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

interface Line {
  /** When it happened; when it arrived when left out. */
  at?: Date;
  arrived: Date;
  project?: string;
  environment?: string;
  service?: string;
  severity?: number;
  body?: string;
}

async function lines(rows: Line[]) {
  await insertRows(
    dashboard.reader.client,
    "logs",
    rows.map((row) => ({
      project_id: row.project ?? projectId,
      timestamp: time(row.at ?? row.arrived),
      observed_timestamp: time(row.at ?? row.arrived),
      received_at: time(row.arrived),
      id: randomUUID().replaceAll("-", ""),
      severity_number: row.severity ?? 17,
      severity_text: "",
      body: row.body ?? PRIVATE_BODY,
      service: row.service ?? "server",
      environment: row.environment ?? "production",
    })),
  );
}

describe("evaluation", () => {
  test("fires on one matching line with N = 0, and resolves when a window holds none", async () => {
    const ruleId = await insertRule({});
    // Arrived before the window (AT - 30 s - 5 min): not counted.
    await lines([{ arrived: after(-6) }]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "none", reading: { value: 0 } });
    await lines([{ arrived: after(-1) }]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 1 } });
    // Still in the window: still firing, nothing more sent.
    expect(await evaluate(ruleId, after(2))).toMatchObject({ outcome: "none" });
    // A whole window later, no line: resolved at once.
    expect(await evaluate(ruleId, after(5))).toMatchObject({
      outcome: "sent",
      reading: { value: 0 },
    });
    const [fired, resolved, more] = await sent();
    expect(more).toBeUndefined();
    expect(fired).toMatchObject({
      type: "log.lines",
      message:
        "Main site: at least 1 log line of Error or above from server in production in the last 5 minutes.",
      subject: {
        type: "log_lines",
        environment: "production",
        service: "server",
        severity: "error",
        search: null,
        windowMinutes: 5,
        maxCount: 0,
        count: 1,
        ruleId,
      },
    });
    expect(resolved).toMatchObject({
      type: "log.lines_resolved",
      message:
        "Main site: no log lines of Error or above from server in production in the last 5 minutes.",
    });
    const history = await dashboard.db
      .selectFrom("alert_history")
      .select(["kind", "subject_name", "resolved_at"])
      .where("rule_id", "=", ruleId)
      .execute();
    expect(history).toEqual([
      { kind: "log_lines", subject_name: "Logs (server, Error)", resolved_at: expect.any(Date) },
    ]);
  });

  test("counts only lines the filters match: severity, service, words, environment, project", async () => {
    const ruleId = await insertRule({ search: "card declined" });
    await lines([
      // Below the severity: a warning.
      { arrived: after(-2), severity: 13 },
      // Another service.
      { arrived: after(-2), service: "worker" },
      // Without every word.
      { arrived: after(-2), body: "card accepted" },
      // Another environment, another project.
      { arrived: after(-2), environment: "staging" },
      { arrived: after(-2), project: otherId },
      // No severity at all.
      { arrived: after(-2), severity: 0 },
    ]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "none", reading: { value: 0 } });
    // Fatal is above Error; the words match in any case, and inside longer words.
    await lines([{ arrived: after(-1), severity: 21, body: "CARD_DECLINED for order 7" }]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 1 } });
  });

  test("any severity counts lines without one, and every service when none is named", async () => {
    const ruleId = await insertRule({ severity: null, service: null });
    await lines([{ arrived: after(-1), severity: 0, service: "cron" }]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 1 } });
    expect((await sent())[0]?.message).toBe(
      "Main site: at least 1 log line in production in the last 5 minutes.",
    );
  });

  test("counts by arrival: a late line counts once, in the window it arrived in", async () => {
    const ruleId = await insertRule({});
    // Happened 40 minutes before it arrived, within the window.
    await lines([{ at: after(-41), arrived: after(-1) }]);
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 1 } });
    // The next window no longer counts it.
    expect(await evaluate(ruleId, after(5))).toMatchObject({ reading: { value: 0 } });
  });

  test("fires above N, stops counting at N + 1, and words the count", async () => {
    const ruleId = await insertRule({ maxCount: 2, windowMinutes: 10, search: "timeout" });
    await lines(
      Array.from({ length: 2 }, () => ({ arrived: after(-3), body: "db timeout after 5s" })),
    );
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "none", reading: { value: 2 } });
    await lines(
      Array.from({ length: 5 }, () => ({ arrived: after(-2), body: "db timeout after 5s" })),
    );
    expect(await evaluate(ruleId, AT)).toMatchObject({ outcome: "sent", reading: { value: 3 } });
    expect(await evaluate(ruleId, after(11))).toMatchObject({
      outcome: "sent",
      reading: { value: 0 },
    });
    const [fired, resolved] = await sent();
    expect(fired?.message).toBe(
      'Main site: more than 2 log lines of Error or above from server with the words "timeout" in production in the last 10 minutes.',
    );
    expect(fired?.subject).toMatchObject({ count: 3, maxCount: 2 });
    expect(resolved?.message).toBe(
      'Main site: 0 log lines of Error or above from server with the words "timeout" in production in the last 10 minutes, at or below the rule\'s 2.',
    );
  });

  test("the message and link name the filter, never a line's text", async () => {
    const ruleId = await insertRule({ search: "declined" });
    await lines([{ arrived: after(-1) }]);
    expect((await evaluate(ruleId, AT)).outcome).toBe("sent");
    const [fired] = await sent();
    const whole = JSON.stringify(fired);
    expect(whole).not.toContain("alice");
    expect(whole).not.toContain("4242");
    const url = new URL(fired?.url ?? "");
    expect(url.origin + url.pathname).toBe(`${PUBLIC}/projects/${projectId}/logs`);
    // Values are JSON, as the dashboard reads them (fire.ts, dashboardLink).
    const value = (key: string) => JSON.parse(url.searchParams.get(key) ?? "null");
    expect(value("env")).toBe("production");
    expect(value("service")).toBe("server");
    expect(value("severity")).toBe("error");
    expect(value("q")).toBe("declined");
    // From 5 minutes before the window's first arrival to the evaluation, in whole minutes.
    expect(value("start")).toBe(new Date(AT.getTime() - 11 * MINUTE).toISOString());
    expect(value("end")).toBe(AT.toISOString());
  });

  test("the worker's pass takes and evaluates them with the other telemetry rules", async () => {
    const ruleId = await insertRule({});
    await lines([{ arrived: after(-1) }]);
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
});

describe("the query", () => {
  test("words read the body's text index, as on the Logs page", async () => {
    const { query, params } = matchingLinesQuery(
      projectId,
      settingsOf({ search: "declined" }),
      { from: after(-5), to: AT },
      1,
    );
    const result = await dashboard.reader.client.query({
      query: `EXPLAIN indexes = 1 ${query}`,
      query_params: params.values,
      format: "TabSeparatedRaw",
    });
    expect(await result.text()).toContain("body_text");
  });

  test("reads a bounded number of rows on a project with many log lines", async () => {
    // Two days of a busy project's error lines, one every 2 seconds: 86,400 rows.
    await dashboard.reader.client.command({
      query: `INSERT INTO logs (project_id, timestamp, received_at, id, severity_number, body,
                                service, environment)
              SELECT {project:UUID}, ts, ts, toString(number), 17, 'request failed: timeout',
                     'server', 'production'
              FROM (SELECT number, toDateTime64({end:String}, 9, 'UTC')
                      - toIntervalSecond(number * 2) AS ts FROM numbers(86400))`,
      query_params: { project: projectId, end: time(AT) },
    });
    const window = { from: after(-5), to: AT };
    // No line of the service: the window and the hour around it, not the two days.
    expect(
      await matchingLines(dashboard.reader, projectId, settingsOf({ service: "cron" }), window, 1),
    ).toBe(0);
    // Matching lines: the count stops at N + 1.
    expect(
      await matchingLines(
        dashboard.reader,
        projectId,
        settingsOf({ search: "timeout" }),
        window,
        4,
      ),
    ).toBe(4);
    await dashboard.reader.client.command({ query: "SYSTEM FLUSH LOGS" });
    const reads = await (
      await dashboard.reader.client.query({
        query: `SELECT read_rows FROM system.query_log
                WHERE type = 'QueryFinish' AND current_database = currentDatabase()
                  AND query LIKE '%FROM logs WHERE%received_at >%' AND query NOT LIKE '%query_log%'
                ORDER BY event_time_microseconds DESC
                LIMIT 2`,
        format: "JSONEachRow",
      })
    ).json<{ read_rows: string }>();
    expect(reads).toHaveLength(2);
    // The window plus the hour before and after it in event time, in granules of 8,192 rows.
    for (const read of reads) expect(Number(read.read_rows)).toBeLessThanOrEqual(5 * 8192);
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
    kind: "log_lines",
    ...body,
  });
  expect(response.statusCode).toBe(400);
  const answer = response.json<{ error: string; code?: string }>();
  return answer.code ?? answer.error;
};

describe("the rule routes", () => {
  test("save with defaults, and warn when no line of the service arrived in the last day", async () => {
    const created = await api(dashboard.cookie, "POST", rules(), {
      kind: "log_lines",
      settings: { service: "server" },
      channelIds: [channelId],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      rule: expect.objectContaining({
        name: "Log lines match",
        kind: "log_lines",
        settings: {
          environment: "production",
          service: "server",
          severity: "error",
          search: null,
          windowMinutes: 5,
          maxCount: 0,
        },
      }),
      warning: {
        reason: "not_seen",
        message:
          "No log lines from server arrived in production in the last 24 hours. The rule is saved. Monitoring starts when the service sends logs.",
      },
    });
    await lines([{ arrived: new Date(Date.now() - MINUTE), severity: 9, service: "server" }]);
    const any = await api(dashboard.cookie, "POST", rules(), {
      kind: "log_lines",
      settings: {
        service: "server",
        severity: null,
        search: "  payment declined ",
        windowMinutes: 60,
        maxCount: 10,
      },
      channelIds: [channelId],
    });
    expect(any.json()).toMatchObject({
      rule: {
        settings: { severity: null, search: "payment declined", windowMinutes: 60, maxCount: 10 },
      },
      warning: null,
    });
    // Text without words searches for nothing, so it is stored as none.
    const changed = await api(dashboard.cookie, "PATCH", rules(`/${any.json().rule.id}`), {
      settings: { search: ":: --" },
    });
    expect(changed.json().rule.settings).toMatchObject({ search: null, maxCount: 10 });
  });

  test("refuse settings the kind does not take", async () => {
    expect(await refused({ settings: { windowMinutes: 61 } })).toBe("invalid_window");
    expect(await refused({ settings: { windowMinutes: 4 } })).toBe("FST_ERR_VALIDATION");
    expect(await refused({ settings: { maxCount: -1 } })).toBe("FST_ERR_VALIDATION");
    expect(await refused({ settings: { maxCount: 1.5 } })).toBe("FST_ERR_VALIDATION");
    expect(await refused({ settings: { severity: "loud" } })).toBe("FST_ERR_VALIDATION");
    expect(await refused({ settings: { search: "a b c d e f g h i" } })).toBe("invalid_search");
    expect(await refused({ settings: { search: "a".repeat(201) } })).toBe("FST_ERR_VALIDATION");
    expect(await refused({ settings: { service: "a\u0001" } })).toBe("FST_ERR_VALIDATION");
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
  test("the rules and their alerts show to monitoring readers only", async () => {
    const web = await member(`web-${randomUUID()}@example.com`, { web_analytics: "view" });
    const monitoring = await member(`monitoring-${randomUUID()}@example.com`, {
      monitoring: "view",
    });
    const now = new Date();
    const ruleId = await insertRule({}, new Date(now.getTime() - 3_600_000));
    await lines([{ arrived: new Date(now.getTime() - MINUTE) }]);
    expect((await evaluate(ruleId, now)).outcome).toBe("sent");
    const kindsOf = async (cookie: string) =>
      (await api(cookie, "GET", rules())).json().rules.map((rule: { kind: string }) => rule.kind);
    const inbox = async (cookie: string) =>
      (await api(cookie, "GET", "/notifications"))
        .json()
        .notifications.map((item: { title: string }) => item.title);
    expect(await kindsOf(web.cookie)).toEqual([]);
    expect(await inbox(web.cookie)).toEqual([]);
    expect((await api(web.cookie, "GET", rules(`/${ruleId}`))).statusCode).toBe(404);
    expect(
      (await api(web.cookie, "POST", rules(), { kind: "log_lines", channelIds: [channelId] }))
        .statusCode,
    ).toBe(403);
    expect(await kindsOf(monitoring.cookie)).toEqual(["log_lines"]);
    expect(await inbox(monitoring.cookie)).toEqual(["Log lines matched: Server errors"]);
    const created = await api(monitoring.cookie, "POST", rules(), {
      kind: "log_lines",
      channelIds: [channelId],
    });
    expect(created.statusCode).toBe(201);
  });
});

const logsOf = async (query: string) => {
  const response = await api(dashboard.cookie, "GET", `/projects/${projectId}/logs?${query}`);
  return { status: response.statusCode, body: response.json() };
};

describe("the Logs page's time window", () => {
  test("lists only the lines of the window, and charts it in small steps", async () => {
    await lines([
      { arrived: after(-30), body: "before the window" },
      { arrived: after(-3), body: "in the window" },
      { arrived: after(1), body: "after the window" },
    ]);
    const start = encodeURIComponent(after(-10).toISOString());
    const end = encodeURIComponent(AT.toISOString());
    const { status, body } = await logsOf(`start=${start}&end=${end}`);
    expect(status).toBe(200);
    expect(body.logs.map((log: { body: string }) => log.body)).toEqual(["in the window"]);
    const volume = await api(
      dashboard.cookie,
      "GET",
      `/projects/${projectId}/logs/volume?start=${start}&end=${end}`,
    );
    expect(volume.json()).toMatchObject({ stepSeconds: 60, total: 1 });
    expect(volume.json().buckets).toBeLessThanOrEqual(11);
  });

  test("refuses a window without both ends, with days, backwards, or past a day", async () => {
    const start = after(-10).toISOString();
    const end = AT.toISOString();
    expect((await logsOf(`start=${start}`)).body.error).toBe("invalid_range");
    expect((await logsOf(`start=${start}&end=${end}&period=7d`)).body.error).toBe("invalid_range");
    expect((await logsOf(`start=${end}&end=${start}`)).body.error).toBe("invalid_range");
    expect((await logsOf(`start=${after(-24 * 60 - 1).toISOString()}&end=${end}`)).body.error).toBe(
      "invalid_range",
    );
    expect((await logsOf(`start=yesterday&end=${end}`)).status).toBe(400);
  });
});
