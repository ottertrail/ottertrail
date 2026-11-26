import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { evaluateCheckDown } from "../src/alerts/check-rules.ts";
import { isPayload, type NotificationPayload } from "../src/notifications/events.ts";
import {
  defaultGrace,
  HEARTBEAT_GRACES,
  HEARTBEAT_PERIODS,
  markOverdue,
  MAX_PINGS_KEPT,
  spanText,
} from "../src/uptime/heartbeats.ts";
import { CheckScheduler } from "../src/uptime/scheduler.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Guard heartbeat checks: the ping route, their states, alerts, and access (docs/uptime-alerts.md). */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The clock of these tests: a whole minute, a little in the past. */
const START = new Date(Math.floor((Date.now() - 3 * DAY) / MINUTE) * MINUTE);
let clock = START;
const later = (ms: number) => new Date(START.getTime() + ms);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherProjectId = "";

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: object,
  cookie = dashboard.cookie,
  project = projectId,
) {
  return dashboard.app.inject({
    method,
    url: `/api/projects/${project}${path}`,
    headers: { cookie, origin: PUBLIC_URL },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Adds a heartbeat through the API, and reads its ping URL. */
async function addHeartbeat(fields: object = {}, project = projectId) {
  const added = await call(
    "POST",
    "/checks",
    { kind: "heartbeat", name: "Nightly backup", ...fields },
    dashboard.cookie,
    project,
  );
  expect(added.statusCode).toBe(201);
  const check = added.json<{ check: { id: string } }>().check;
  const pingUrl = await call(
    "GET",
    `/checks/${check.id}/ping-url`,
    undefined,
    dashboard.cookie,
    project,
  );
  expect(pingUrl.statusCode).toBe(200);
  const { url } = pingUrl.json<{ url: string }>();
  return { id: check.id, url, path: new URL(url).pathname };
}

function ping(
  path: string,
  method: "GET" | "POST" | "HEAD" = "GET",
  more: { payload?: string; headers?: Record<string, string>; remoteAddress?: string } = {},
) {
  return dashboard.app.inject({
    method,
    url: path,
    ...(more.payload === undefined ? {} : { payload: more.payload }),
    ...(more.headers === undefined ? {} : { headers: more.headers }),
    remoteAddress: more.remoteAddress ?? "203.0.113.10",
  });
}

async function checkRow(id: string) {
  return dashboard.db
    .selectFrom("uptime_checks")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function incidentsOf(id: string) {
  return dashboard.db
    .selectFrom("uptime_incidents")
    .selectAll()
    .where("check_id", "=", id)
    .orderBy("started_at")
    .execute();
}

beforeAll(async () => {
  dashboard = await signedInDashboard({
    now: () => clock,
    // Room for the tests' pings; the limits have their own app below.
    heartbeats: {
      ipLimit: { capacity: 1000, refillPerSecond: 1000 },
      checkLimit: { capacity: 1000, refillPerSecond: 1000 },
    },
  });
  projectId = (await insertProject(dashboard.db, { name: "Shop" })).id;
  otherProjectId = (await insertProject(dashboard.db, { name: "Blog" })).id;
});

afterAll(async () => {
  await dashboard?.close();
});

beforeEach(async () => {
  clock = START;
  await dashboard.db.deleteFrom("alert_rules").execute();
  await dashboard.db.deleteFrom("notification_channels").execute();
  await dashboard.db.deleteFrom("uptime_checks").execute();
});

describe("adding a heartbeat", () => {
  test("takes a name, with a period of a day and a default grace, and waits for its first ping", async () => {
    const added = await call("POST", "/checks", { kind: "heartbeat", name: " Nightly backup " });
    expect(added.statusCode).toBe(201);
    const { check } = added.json();
    expect(check).toMatchObject({
      kind: "heartbeat",
      name: "Nightly backup",
      url: null,
      method: null,
      timeoutSeconds: null,
      expectedStatuses: null,
      failuresBeforeDown: null,
      intervalSeconds: 86_400,
      graceSeconds: 7200,
      state: "pending",
      paused: false,
      lastCheckedAt: null,
      expectedAt: later(DAY).toISOString(),
    });
    // The token is only on its own route.
    expect(added.body).not.toContain("ping");
    expect((await checkRow(check.id)).next_due_at).toEqual(later(DAY + 2 * HOUR));
  });

  test("takes a period and a grace from the lists only", async () => {
    const added = await call("POST", "/checks", {
      kind: "heartbeat",
      name: "Queue",
      intervalSeconds: 300,
      graceSeconds: 60,
    });
    expect(added.json().check).toMatchObject({ intervalSeconds: 300, graceSeconds: 60 });
    expect(
      (await call("POST", "/checks", { kind: "heartbeat", name: "X", intervalSeconds: 120 }))
        .statusCode,
    ).toBe(400);
    const grace = await call("POST", "/checks", {
      kind: "heartbeat",
      name: "X",
      intervalSeconds: 3600,
      graceSeconds: 604_800,
    });
    expect(grace.statusCode).toBe(400);
    // An HTTP check takes neither a heartbeat's period nor a grace.
    const http = await call("POST", "/checks", {
      url: "https://example.com",
      intervalSeconds: 86_400,
    });
    expect(http.json()).toMatchObject({ error: "invalid_interval" });
    expect(
      (await call("POST", "/checks", { url: "https://example.com", graceSeconds: 60 })).json(),
    ).toMatchObject({ error: "invalid_field" });
  });

  test("needs a name, and takes no field of an HTTP check", async () => {
    const unnamed = await call("POST", "/checks", { kind: "heartbeat" });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json()).toMatchObject({ error: "invalid_name" });
    const withUrl = await call("POST", "/checks", {
      kind: "heartbeat",
      name: "X",
      url: "https://example.com",
    });
    expect(withUrl.statusCode).toBe(400);
    expect(withUrl.json()).toMatchObject({ error: "invalid_field" });
  });

  test("the default grace is a share of the period", () => {
    expect(HEARTBEAT_PERIODS.map((period) => [period, defaultGrace(period)])).toEqual([
      [60, 60],
      [300, 60],
      [600, 60],
      [900, 60],
      [1800, 300],
      [3600, 600],
      [7200, 900],
      [21_600, 3600],
      [43_200, 7200],
      [86_400, 7200],
      [604_800, 86_400],
    ]);
    for (const period of HEARTBEAT_PERIODS) {
      expect(HEARTBEAT_GRACES).toContain(defaultGrace(period));
    }
    expect(spanText(86_400 + 3600)).toBe("1 day and 1 hour");
    expect(spanText(360)).toBe("6 minutes");
    expect(spanText(86_400 + 3600 + 300)).toBe("1 day, 1 hour, and 5 minutes");
    expect(spanText(604_800 + 86_400)).toBe("8 days");
  });
});

describe("the ping URL", () => {
  test("is long, random, and URL-safe, under the instance's address", async () => {
    const { url } = await addHeartbeat();
    expect(url).toMatch(new RegExp(`^${PUBLIC_URL}/api/heartbeats/[A-Za-z0-9_-]{32}$`));
    const other = await addHeartbeat();
    expect(other.url).not.toBe(url);
  });

  test("answers GET, POST, and HEAD with a tiny body, and marks the heartbeat up", async () => {
    const { id, path } = await addHeartbeat();
    for (const method of ["GET", "POST", "HEAD"] as const) {
      clock = later(MINUTE);
      const answer = await ping(path, method);
      expect(answer.statusCode).toBe(200);
      expect(answer.body).toBe(method === "HEAD" ? "" : "OK\n");
      expect(answer.headers["cache-control"]).toBe("no-store");
    }
    const row = await checkRow(id);
    expect(row).toMatchObject({ state: "up", last_up: true, last_checked_at: later(MINUTE) });
    expect(row.next_due_at).toEqual(later(MINUTE + DAY + 2 * HOUR));
    const detail = await call("GET", `/checks/${id}/pings`);
    expect(detail.json().pings).toHaveLength(3);
    expect(detail.json().pings[0]).toEqual({ at: later(MINUTE).toISOString(), failed: false });
  });

  test("ignores any body, whatever its type, and stores none of it", async () => {
    const { id, path } = await addHeartbeat();
    const bodies = [
      { payload: '{"secret":"do-not-keep"}', headers: { "content-type": "application/json" } },
      {
        payload: "secret=do-not-keep",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      { payload: "do-not-keep ".repeat(200_000), headers: { "content-type": "text/plain" } },
      { payload: "not json {", headers: { "content-type": "application/json" } },
    ];
    for (const body of bodies) {
      expect((await ping(path, "POST", body)).statusCode).toBe(200);
    }
    const pings = await dashboard.db
      .selectFrom("heartbeat_pings")
      .selectAll()
      .where("check_id", "=", id)
      .execute();
    expect(pings).toHaveLength(4);
    expect(Object.keys(pings[0] ?? {}).toSorted()).toEqual([
      "at",
      "check_id",
      "failed",
      "id",
      "project_id",
    ]);
    expect(JSON.stringify(await checkRow(id))).not.toContain("do-not-keep");
  });

  test("keeps the latest pings only", async () => {
    const { id, path } = await addHeartbeat();
    for (let index = 0; index < MAX_PINGS_KEPT + 5; index += 1) {
      clock = later(index * MINUTE);
      await ping(path);
    }
    const detail = (await call("GET", `/checks/${id}/pings`)).json();
    expect(detail.pings).toHaveLength(MAX_PINGS_KEPT);
    expect(detail.pings[0].at).toBe(later((MAX_PINGS_KEPT + 4) * MINUTE).toISOString());
  });

  test("an unknown, malformed, or paused token answers 404 the same way", async () => {
    const { id, path } = await addHeartbeat();
    const unknown = await ping(`/api/heartbeats/${"a".repeat(32)}`);
    const malformed = await ping("/api/heartbeats/short");
    await call("PATCH", `/checks/${id}`, { paused: true });
    const paused = await ping(path);
    const pausedFail = await ping(`${path}/fail`, "POST");
    for (const answer of [unknown, malformed, paused, pausedFail]) {
      expect(answer.statusCode).toBe(404);
      expect(answer.body).toBe("Not found\n");
    }
    expect(await dashboard.db.selectFrom("heartbeat_pings").selectAll().execute()).toEqual([]);
    expect((await checkRow(id)).state).toBe("pending");
  });

  test("a new token works at once, and the old one stops", async () => {
    const { id, path } = await addHeartbeat();
    const replaced = await call("POST", `/checks/${id}/ping-url`);
    expect(replaced.statusCode).toBe(200);
    expect(replaced.headers["cache-control"]).toBe("no-store");
    const next = new URL(replaced.json<{ url: string }>().url).pathname;
    expect(next).not.toBe(path);
    expect((await ping(path)).statusCode).toBe(404);
    expect((await ping(next)).statusCode).toBe(200);
    expect((await call("GET", `/checks/${id}/ping-url`)).json().url).toBe(`${PUBLIC_URL}${next}`);
  });

  test("an HTTP check has no ping URL", async () => {
    const http = await call("POST", "/checks", { url: "https://example.com" });
    const id = http.json().check.id as string;
    expect((await call("GET", `/checks/${id}/ping-url`)).statusCode).toBe(404);
    expect((await call("GET", `/checks/${id}/pings`)).statusCode).toBe(404);
    expect((await call("POST", `/checks/${id}/ping-url`)).statusCode).toBe(404);
  });
});

describe("states", () => {
  test("new, then up on a ping, down after the period and grace, and up again", async () => {
    const { id, path } = await addHeartbeat({ intervalSeconds: 86_400, graceSeconds: 3600 });
    // New: never down before its first period and grace.
    expect(await markOverdue(dashboard.db, later(DAY + HOUR - 1000))).toEqual([]);
    expect((await checkRow(id)).state).toBe("pending");

    clock = later(2 * HOUR);
    await ping(path);
    expect((await checkRow(id)).state).toBe("up");
    // Within the grace: still up.
    expect(await markOverdue(dashboard.db, later(2 * HOUR + DAY + HOUR - 1000))).toEqual([]);
    const changes = await markOverdue(dashboard.db, later(2 * HOUR + DAY + HOUR));
    expect(changes).toMatchObject([
      {
        checkId: id,
        from: "up",
        to: "down",
        cause: "no_ping",
        detail: "No ping for 1 day and 1 hour.",
      },
    ]);
    expect(await checkRow(id)).toMatchObject({
      state: "down",
      failing_cause: "no_ping",
      failing_since: later(2 * HOUR + DAY + HOUR),
    });
    // Once down, it is not taken again.
    expect(await markOverdue(dashboard.db, later(3 * DAY))).toEqual([]);

    clock = later(2 * DAY);
    await ping(path);
    expect((await checkRow(id)).state).toBe("up");
    const [incident] = await incidentsOf(id);
    expect(incident).toMatchObject({
      cause: "no_ping",
      detail: "No ping for 1 day and 1 hour.",
      started_at: later(2 * HOUR + DAY + HOUR),
      ended_at: later(2 * DAY),
    });
  });

  test("a new heartbeat that never pings goes down after its first period and grace", async () => {
    const { id } = await addHeartbeat({ intervalSeconds: 300, graceSeconds: 60 });
    expect(await markOverdue(dashboard.db, later(6 * MINUTE))).toMatchObject([
      { checkId: id, from: "pending", to: "down", detail: "No ping for 6 minutes." },
    ]);
  });

  test("/fail takes it down at once, and the next ping brings it back", async () => {
    const { id, path } = await addHeartbeat();
    clock = later(MINUTE);
    const failed = await ping(`${path}/fail`, "POST");
    expect(failed.statusCode).toBe(200);
    expect(await checkRow(id)).toMatchObject({
      state: "down",
      last_up: false,
      last_cause: "job_failed",
      failing_cause: "job_failed",
      failing_detail: "The job reported a failure.",
    });
    // A second failure is the same incident.
    clock = later(2 * MINUTE);
    await ping(`${path}/fail`);
    expect(await incidentsOf(id)).toHaveLength(1);
    clock = later(3 * MINUTE);
    await ping(path, "HEAD");
    expect((await checkRow(id)).state).toBe("up");
    expect(await incidentsOf(id)).toMatchObject([
      { cause: "job_failed", started_at: later(MINUTE), ended_at: later(3 * MINUTE) },
    ]);
    const detail = (await call("GET", `/checks/${id}/pings`)).json();
    expect(detail.pings.map((item: { failed: boolean }) => item.failed)).toEqual([
      false,
      true,
      true,
    ]);
  });

  test("pausing ends the incident and stops the clock; resuming waits a whole period again", async () => {
    const { id, path } = await addHeartbeat({ intervalSeconds: 3600, graceSeconds: 600 });
    await ping(`${path}/fail`);
    clock = later(10 * MINUTE);
    const paused = await call("PATCH", `/checks/${id}`, { paused: true });
    expect(paused.json().check).toMatchObject({ paused: true, state: "pending", expectedAt: null });
    expect((await incidentsOf(id))[0]?.ended_at).toEqual(later(10 * MINUTE));
    expect(await markOverdue(dashboard.db, later(5 * HOUR))).toEqual([]);

    clock = later(5 * HOUR);
    const resumed = await call("PATCH", `/checks/${id}`, { paused: false });
    expect(resumed.json().check).toMatchObject({
      paused: false,
      state: "pending",
      expectedAt: later(6 * HOUR).toISOString(),
    });
    expect(await markOverdue(dashboard.db, later(6 * HOUR + 10 * MINUTE - 1000))).toEqual([]);
    expect(await markOverdue(dashboard.db, later(6 * HOUR + 10 * MINUTE))).toHaveLength(1);
  });

  test("a new period or grace moves the deadline from the last ping", async () => {
    const { id, path } = await addHeartbeat({ intervalSeconds: 3600, graceSeconds: 600 });
    clock = later(HOUR);
    await ping(path);
    const changed = await call("PATCH", `/checks/${id}`, {
      intervalSeconds: 86_400,
      graceSeconds: 3600,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().check).toMatchObject({ expectedAt: later(HOUR + DAY).toISOString() });
    expect((await checkRow(id)).next_due_at).toEqual(later(HOUR + DAY + HOUR));
    expect(
      (await call("PATCH", `/checks/${id}`, { url: "https://example.com" })).json(),
    ).toMatchObject({ error: "invalid_field" });
  });

  test("the worker takes each overdue heartbeat once, and leaves HTTP checks alone", async () => {
    await addHeartbeat({ intervalSeconds: 60, graceSeconds: 60 });
    await addHeartbeat({ intervalSeconds: 60, graceSeconds: 60 });
    await call("POST", "/checks", { url: "https://example.com" });
    const changes: string[] = [];
    const scheduler = () =>
      new CheckScheduler({
        db: dashboard.db,
        clickhouse: undefined as never,
        policy: undefined as never,
        takeAt: () => later(10 * MINUTE),
        onStateChange: (change) => {
          changes.push(change.checkId);
        },
      });
    const [first, second] = await Promise.all([
      scheduler().watchHeartbeats(),
      scheduler().watchHeartbeats(),
    ]);
    expect((first ?? 0) + (second ?? 0)).toBe(2);
    expect(new Set(changes).size).toBe(2);
    const http = await dashboard.db
      .selectFrom("uptime_checks")
      .select("state")
      .where("kind", "=", "http")
      .executeTakeFirstOrThrow();
    expect(http.state).toBe("pending");
  });

  test("the overdue query reads the heartbeats' index", async () => {
    await addHeartbeat();
    // A table this small is read whole unless told otherwise; the plan shows the index fits.
    const plan = await dashboard.db.transaction().execute(async (trx) => {
      await sql`set local enable_seqscan = off`.execute(trx);
      return sql<{ "QUERY PLAN": string }>`explain select id from uptime_checks
        where kind = 'heartbeat' and paused = false and state <> 'down' and next_due_at <= now()
        order by next_due_at limit 500 for update skip locked`.execute(trx);
    });
    expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
      "uptime_heartbeats_due_idx",
    );
  });
});

async function watchAll() {
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
  const rule = await dashboard.db
    .insertInto("alert_rules")
    .values({
      project_id: projectId,
      name: "Anything down",
      kind: "check_down",
      settings: JSON.stringify({ checkId: null }),
      channel_ids: [channel.id],
      active_since: START,
      created_at: START,
      updated_at: START,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return rule.id;
}

async function sent(): Promise<NotificationPayload[]> {
  const rows = await dashboard.db
    .selectFrom("notification_deliveries")
    .select("payload")
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map((row) => {
    if (!isPayload(row.payload)) throw new Error("not a payload");
    return row.payload;
  });
}

describe("alerts", () => {
  test("/fail fires the check-down rule from the ping, and the next ping resolves it", async () => {
    const ruleId = await watchAll();
    const { id, path } = await addHeartbeat();
    clock = later(MINUTE);
    await ping(`${path}/fail`);
    clock = later(20 * MINUTE);
    await ping(path);
    const notes = await sent();
    expect(notes.map((note) => [note.type, note.message])).toEqual([
      ["check.down", 'Shop: the heartbeat "Nightly backup" is down. The job reported a failure.'],
      ["check.up", 'Shop: the heartbeat "Nightly backup" is up again, after 19 minutes down.'],
    ]);
    expect(notes[0]?.subject).toMatchObject({ type: "check", id, url: null });
    expect(JSON.stringify(notes)).not.toContain(path.split("/").at(-1));
    const history = await dashboard.db
      .selectFrom("alert_history")
      .selectAll()
      .where("rule_id", "=", ruleId)
      .execute();
    expect(history).toMatchObject([{ subject: id, resolved_at: later(20 * MINUTE) }]);
  });

  test("a heartbeat the worker finds overdue fires the rule, in plain words", async () => {
    await watchAll();
    const { path } = await addHeartbeat({ intervalSeconds: 86_400, graceSeconds: 3600 });
    const scheduler = new CheckScheduler({
      db: dashboard.db,
      clickhouse: undefined as never,
      policy: undefined as never,
      takeAt: () => later(2 * DAY),
      onStateChange: async (change) => {
        await evaluateCheckDown(
          { db: dashboard.db, publicUrl: PUBLIC_URL },
          { projectId: change.projectId, checkId: change.checkId },
          later(2 * DAY),
        );
      },
    });
    expect(await scheduler.watchHeartbeats()).toBe(1);
    expect((await sent()).map((note) => note.message)).toEqual([
      'Shop: the heartbeat "Nightly backup" is down. No ping for 1 day and 1 hour.',
    ]);
    clock = later(2 * DAY + HOUR);
    await ping(path);
    expect((await sent()).map((note) => note.type)).toEqual(["check.down", "check.up"]);
  });
});

describe("access and isolation", () => {
  test("members who manage checks see the URL and make a new one; those who only view do not", async () => {
    const { id } = await addHeartbeat();
    const viewer = await signedInUser(dashboard, {
      name: "Vic Viewer",
      email: "vic@example.com",
      grants: { projects: "all", areas: { uptime_alerts: "view" } },
    });
    const manager = await signedInUser(dashboard, {
      name: "Max Manager",
      email: "max@example.com",
      grants: { projects: "all", areas: { uptime_alerts: "manage" } },
    });
    const seen = await call("GET", `/checks/${id}`, undefined, viewer.cookie);
    expect(seen.statusCode).toBe(200);
    expect((await call("GET", `/checks/${id}/pings`, undefined, viewer.cookie)).statusCode).toBe(
      200,
    );
    const token = (await call("GET", `/checks/${id}/ping-url`)).json().url.split("/").at(-1);
    expect(seen.body).not.toContain(token);
    expect((await call("GET", "/checks", undefined, viewer.cookie)).body).not.toContain(token);
    expect((await call("GET", `/checks/${id}/ping-url`, undefined, viewer.cookie)).statusCode).toBe(
      403,
    );
    expect(
      (await call("POST", `/checks/${id}/ping-url`, undefined, viewer.cookie)).statusCode,
    ).toBe(403);
    expect(
      (await call("GET", `/checks/${id}/ping-url`, undefined, manager.cookie)).statusCode,
    ).toBe(200);
    expect(
      (await call("POST", `/checks/${id}/ping-url`, undefined, manager.cookie)).statusCode,
    ).toBe(200);
  });

  test("another project's heartbeat is not found, and a ping reaches its own check only", async () => {
    const own = await addHeartbeat();
    const other = await addHeartbeat({ name: "Blog backup" }, otherProjectId);
    expect((await call("GET", `/checks/${other.id}/ping-url`)).statusCode).toBe(404);
    expect((await call("POST", `/checks/${other.id}/ping-url`)).statusCode).toBe(404);
    expect((await call("GET", `/checks/${other.id}`)).statusCode).toBe(404);
    await ping(`${other.path}/fail`);
    expect((await checkRow(other.id)).state).toBe("down");
    expect((await checkRow(own.id)).state).toBe("pending");
    const pings = await dashboard.db
      .selectFrom("heartbeat_pings")
      .select(["check_id", "project_id"])
      .execute();
    expect(pings).toEqual([{ check_id: other.id, project_id: otherProjectId }]);
  });

  test("the ping needs no session and no key", async () => {
    const { path } = await addHeartbeat();
    const answer = await dashboard.app.inject({ method: "GET", url: path });
    expect(answer.statusCode).toBe(200);
  });
});

describe("rate limits", () => {
  let limited: Awaited<ReturnType<typeof signedInDashboard>>;
  let limitedProject = "";

  beforeAll(async () => {
    limited = await signedInDashboard({
      heartbeats: {
        ipLimit: { capacity: 4, refillPerSecond: 0.001 },
        checkLimit: { capacity: 2, refillPerSecond: 0.001 },
      },
    });
    limitedProject = (await insertProject(limited.db, { name: "Shop" })).id;
  });

  afterAll(async () => {
    await limited?.close();
  });

  async function heartbeatPath() {
    const added = await limited.app.inject({
      method: "POST",
      url: `/api/projects/${limitedProject}/checks`,
      headers: { cookie: limited.cookie, origin: PUBLIC_URL },
      payload: { kind: "heartbeat", name: "Job" },
    });
    const id = added.json<{ check: { id: string } }>().check.id;
    const read = await limited.app.inject({
      method: "GET",
      url: `/api/projects/${limitedProject}/checks/${id}/ping-url`,
      headers: { cookie: limited.cookie },
    });
    return new URL(read.json<{ url: string }>().url).pathname;
  }

  const pingFrom = (path: string, remoteAddress: string) =>
    limited.app.inject({ method: "GET", url: path, remoteAddress });

  test("per heartbeat, and per client address, unknown tokens included", async () => {
    const first = await heartbeatPath();
    const second = await heartbeatPath();
    const third = await heartbeatPath();
    expect((await pingFrom(first, "198.51.100.1")).statusCode).toBe(200);
    expect((await pingFrom(first, "198.51.100.2")).statusCode).toBe(200);
    const refused = await pingFrom(first, "198.51.100.3");
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // Another heartbeat has its own budget.
    expect((await pingFrom(second, "198.51.100.3")).statusCode).toBe(200);
    // Guessed tokens spend the address's budget.
    for (let index = 0; index < 3; index += 1) {
      const guess = await pingFrom(`/api/heartbeats/${"b".repeat(32)}`, "198.51.100.9");
      expect(guess.statusCode).toBe(404);
    }
    expect((await pingFrom(third, "198.51.100.9")).statusCode).toBe(200);
    expect((await pingFrom(third, "198.51.100.9")).statusCode).toBe(429);
    expect((await pingFrom(third, "198.51.100.10")).statusCode).toBe(200);
  });
});
