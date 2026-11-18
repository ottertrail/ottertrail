import type { Insertable } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { UptimeChecksTable, UptimeIncidentsTable } from "../src/db/schema.ts";
import { MAX_CHECKS, MAX_FIRST_RUN_DELAY_SECONDS } from "../src/uptime/checks.ts";
import { storeResult } from "../src/uptime/results.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { testLookup } from "./helpers/uptime-servers.ts";

/**
 * The uptime routes (docs/uptime-alerts.md): checks added, changed,
 * paused, and deleted, with the address rules on save; uptime worked out
 * from incidents; and a check's response times and failures from
 * ClickHouse.
 */

/** Yesterday, in UTC (the organization's timezone): results stay within ClickHouse's 90 days. */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const at = (time: string) => new Date(`${YESTERDAY}T${time}Z`);
/** The dashboard's clock: yesterday at noon. */
const NOW = at("12:00:00");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const lookup = testLookup({
  "example.com": ["93.184.215.14"],
  "internal.example": ["10.0.0.7"],
  "mixed.example": ["93.184.215.14", "fd00::7"],
  "metadata.example": ["::ffff:169.254.169.254"],
  "own.example": ["203.0.114.7"],
});

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";

function call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: object) {
  return dashboard.app.inject({
    method,
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function insertCheck(values: Partial<Insertable<UptimeChecksTable>> = {}) {
  return dashboard.db
    .insertInto("uptime_checks")
    .values({
      project_id: projectId,
      name: "Health",
      url: "https://example.com/health",
      method: "GET",
      interval_seconds: 60,
      timeout_seconds: 10,
      expected_statuses: "200-399",
      word_mode: "present",
      failures_before_down: 2,
      next_due_at: NOW,
      created_at: ago(40 * DAY),
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function insertIncident(
  checkId: string,
  values: Omit<Insertable<UptimeIncidentsTable>, "check_id" | "project_id" | "cause"> & {
    cause?: UptimeIncidentsTable["cause"];
  },
) {
  await dashboard.db
    .insertInto("uptime_incidents")
    .values({ check_id: checkId, project_id: projectId, cause: "status", ...values })
    .execute();
}

/** A run's outcome: up in 100 ms unless `more` says otherwise. */
const outcome = (more: object) => ({
  up: true,
  statusCode: 200,
  responseMs: 100,
  cause: null,
  detail: "",
  tlsExpiresAt: null,
  ...more,
});

beforeAll(async () => {
  dashboard = await signedInDashboard({
    now: () => NOW,
    // The server's own public address, as an operator lists it in UPTIME_DENY_ADDRESSES.
    uptime: { lookup, denyAddresses: ["203.0.114.7"] },
  });
  projectId = (
    await insertProject(dashboard.db, { organization_id: dashboard.organizationId, name: "Shop" })
  ).id;
});

afterAll(async () => {
  await dashboard?.close();
});

beforeEach(async () => {
  await dashboard.db.deleteFrom("uptime_checks").execute();
});

describe("adding a check", () => {
  test("takes a URL, with defaults for the rest, and runs it within minutes", async () => {
    const added = await call("POST", "/checks", { url: " https://example.com/health#top " });
    expect(added.statusCode).toBe(201);
    const { check } = added.json();
    expect(check).toMatchObject({
      name: "example.com",
      url: "https://example.com/health",
      method: "GET",
      intervalSeconds: 300,
      timeoutSeconds: 10,
      expectedStatuses: "200-399",
      word: null,
      wordMode: "present",
      failuresBeforeDown: 2,
      paused: false,
      state: "pending",
      lastCheckedAt: null,
      uptime: { day: null, week: null, month: null },
    });
    const row = await dashboard.db
      .selectFrom("uptime_checks")
      .select("next_due_at")
      .executeTakeFirstOrThrow();
    const wait = row.next_due_at.getTime() - NOW.getTime();
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(wait).toBeLessThan(MAX_FIRST_RUN_DELAY_SECONDS * 1000);
  });

  test("takes every field, and tidies the status list", async () => {
    const added = await call("POST", "/checks", {
      name: "  Shop home ",
      url: "http://example.com/",
      method: "GET",
      intervalSeconds: 60,
      timeoutSeconds: 30,
      expectedStatuses: " 200 - 299 , 418 ",
      word: "Welcome",
      wordMode: "absent",
      failuresBeforeDown: 5,
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().check).toMatchObject({
      name: "Shop home",
      intervalSeconds: 60,
      timeoutSeconds: 30,
      expectedStatuses: "200-299,418",
      word: "Welcome",
      wordMode: "absent",
      failuresBeforeDown: 5,
    });
  });

  test.each([
    [
      { url: "ftp://example.com/" },
      "invalid_url",
      "A check's URL starts with http:// or https://.",
    ],
    [
      { url: "example.com" },
      "invalid_url",
      "Enter a full URL, such as https://example.com/health.",
    ],
    [
      { url: "https://admin:secret@example.com/" },
      "invalid_url",
      "A check's URL holds no user name or password: they would be stored as plain text.",
    ],
    [
      { url: "https://example.com/", method: "HEAD", word: "ok" },
      "invalid_word",
      "A HEAD request gets no body to look for the word in: use GET.",
    ],
    [
      { url: "https://example.com/", expectedStatuses: "2xx" },
      "invalid_statuses",
      "The status codes that count as up are codes from 100 to 599 and ranges, separated by commas, such as 200-399 or 200, 204.",
    ],
    [
      { url: "https://example.com/", expectedStatuses: "399-200" },
      "invalid_statuses",
      expect.any(String),
    ],
    [
      { url: "https://example.com/", expectedStatuses: "200-600" },
      "invalid_statuses",
      expect.any(String),
    ],
    [{ url: "https://example.com/", name: "a".repeat(101) }, "invalid_name", expect.any(String)],
    [{ url: "https://example.com/", word: "   " }, "invalid_word", expect.any(String)],
  ])("refuses %j with a message", async (body, error, message) => {
    const refused = await call("POST", "/checks", body);
    expect([refused.statusCode, refused.json()]).toEqual([400, { error, message }]);
  });

  test.each([
    [{ url: "https://example.com/", intervalSeconds: 45 }],
    [{ url: "https://example.com/", timeoutSeconds: 31 }],
    [{ url: "https://example.com/", failuresBeforeDown: 6 }],
    [{ url: "https://example.com/", method: "POST" }],
    [{ name: "No URL" }],
  ])("refuses %j by its schema", async (body) => {
    expect((await call("POST", "/checks", body)).statusCode).toBe(400);
  });

  test.each([
    ["http://127.0.0.1:5432/", "127.0.0.1 is a loopback address: checks may not reach it."],
    ["http://[::1]/", "::1 is a loopback address: checks may not reach it."],
    [
      "http://169.254.169.254/latest/meta-data/",
      "169.254.169.254 is a cloud metadata service's address: checks may not reach it.",
    ],
    ["https://internal.example/", "internal.example resolves to an address checks may not reach."],
    ["https://mixed.example/", "mixed.example resolves to an address checks may not reach."],
    [
      "http://203.0.114.7:22/",
      "203.0.114.7 is an address this instance refuses: checks may not reach it.",
    ],
    ["https://own.example/", "own.example resolves to an address checks may not reach."],
    ["https://metadata.example/", "metadata.example resolves to an address checks may not reach."],
  ])("refuses %s, whose address checks may not reach", async (url, message) => {
    const refused = await call("POST", "/checks", { url });
    expect([refused.statusCode, refused.json()]).toEqual([
      400,
      { error: "address_not_allowed", message },
    ]);
    expect(await dashboard.db.selectFrom("uptime_checks").select("id").execute()).toEqual([]);
  });

  test("saves a host that does not resolve yet: its runs say DNS", async () => {
    expect((await call("POST", "/checks", { url: "https://soon.example/" })).statusCode).toBe(201);
  });

  test(`refuses more than ${MAX_CHECKS} checks in a project`, async () => {
    await Promise.all(
      Array.from({ length: MAX_CHECKS - 1 }, (_, index) => insertCheck({ name: `Check ${index}` })),
    );
    expect((await call("POST", "/checks", { url: "https://example.com/" })).statusCode).toBe(201);
    const refused = await call("POST", "/checks", { url: "https://example.com/" });
    expect([refused.statusCode, refused.json()]).toEqual([
      409,
      { error: "too_many_checks", message: "A project has at most 50 checks." },
    ]);
  });
});

describe("a project's checks", () => {
  test("are listed oldest first, read one by one, changed, and deleted", async () => {
    const first = (
      await call("POST", "/checks", { url: "https://example.com/a", name: "A" })
    ).json().check;
    const second = (
      await call("POST", "/checks", { url: "https://example.com/b", name: "B" })
    ).json().check;
    const list = await call("GET", "/checks");
    expect(list.json()).toMatchObject({ timeZone: "UTC", maxChecks: 50 });
    expect(list.json().checks.map((check: { name: string }) => check.name)).toEqual(["A", "B"]);
    expect((await call("GET", `/checks/${first.id}`)).json().check).toMatchObject({ name: "A" });

    const changed = await call("PATCH", `/checks/${first.id}`, {
      name: "Renamed",
      intervalSeconds: 3600,
      word: "ok",
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().check).toMatchObject({
      name: "Renamed",
      intervalSeconds: 3600,
      word: "ok",
      url: "https://example.com/a",
    });
    // A word can be taken off again.
    expect((await call("PATCH", `/checks/${first.id}`, { word: null })).json().check.word).toBe(
      null,
    );

    const refused = await call("PATCH", `/checks/${first.id}`, {
      url: "https://internal.example/",
    });
    expect(refused.json().error).toBe("address_not_allowed");

    expect((await call("DELETE", `/checks/${second.id}`)).statusCode).toBe(204);
    const gone = await call("GET", `/checks/${second.id}`);
    expect([gone.statusCode, gone.json().error]).toEqual([404, "check_not_found"]);
    expect((await call("DELETE", `/checks/${second.id}`)).statusCode).toBe(404);
    expect((await call("PATCH", `/checks/${second.id}`, { name: "x" })).statusCode).toBe(404);
  });

  test("pausing ends an open incident and forgets the state; resuming runs it again soon", async () => {
    const check = await insertCheck({ state: "down", consecutive_failures: 3 });
    await insertIncident(check.id, { started_at: ago(HOUR) });
    const paused = await call("PATCH", `/checks/${check.id}`, { paused: true });
    expect(paused.json().check).toMatchObject({
      paused: true,
      state: "pending",
      consecutiveFailures: 0,
    });
    const incidents = await dashboard.db.selectFrom("uptime_incidents").selectAll().execute();
    expect(incidents.map((incident) => incident.ended_at)).toEqual([NOW]);

    const resumed = await call("PATCH", `/checks/${check.id}`, { paused: false });
    expect(resumed.json().check.paused).toBe(false);
    const { next_due_at: due } = await dashboard.db
      .selectFrom("uptime_checks")
      .select("next_due_at")
      .executeTakeFirstOrThrow();
    expect(due.getTime() - NOW.getTime()).toBeLessThan(60_000);
  });

  test("deleting the project deletes its checks and incidents", async () => {
    const other = await insertProject(dashboard.db, {
      organization_id: dashboard.organizationId,
      name: "Doomed",
    });
    const check = await insertCheck({ project_id: other.id });
    await dashboard.db
      .insertInto("uptime_incidents")
      .values({ check_id: check.id, project_id: other.id, started_at: ago(HOUR), cause: "dns" })
      .execute();
    await dashboard.db.deleteFrom("projects").where("id", "=", other.id).execute();
    expect(await dashboard.db.selectFrom("uptime_checks").select("id").execute()).toEqual([]);
    expect(await dashboard.db.selectFrom("uptime_incidents").select("id").execute()).toEqual([]);
  });
});

describe("uptime", () => {
  test("is the share of each period not inside an incident, worked out by hand", async () => {
    const old = await insertCheck({ name: "Old" });
    // 1 hour, 2 to 1 hours ago.
    await insertIncident(old.id, { started_at: ago(2 * HOUR), ended_at: ago(HOUR) });
    // Still open: 30 minutes so far.
    await insertIncident(old.id, { started_at: ago(HOUR / 2) });
    // 6 hours, three days ago.
    await insertIncident(old.id, { started_at: ago(3 * DAY), ended_at: ago(3 * DAY - 6 * HOUR) });
    // 12 hours, twenty days ago.
    await insertIncident(old.id, {
      started_at: ago(20 * DAY),
      ended_at: ago(20 * DAY - 12 * HOUR),
    });
    // 10 hours, half before the 30 days: only its last 5 hours count.
    await insertIncident(old.id, {
      started_at: ago(30 * DAY + 5 * HOUR),
      ended_at: ago(30 * DAY - 5 * HOUR),
    });
    // Created 6 hours ago, down for 1: a sixth of its time.
    const young = await insertCheck({ name: "Young", created_at: ago(6 * HOUR) });
    await insertIncident(young.id, { started_at: ago(3 * HOUR), ended_at: ago(2 * HOUR) });
    // Never down.
    await insertCheck({ name: "Steady" });

    const checks = (await call("GET", "/checks")).json().checks;
    const uptime = (name: string) =>
      checks.find((check: { name: string }) => check.name === name).uptime;
    // 24 hours: 1 h + 0.5 h down. 7 days: 1.5 h + 6 h. 30 days: 7.5 h + 12 h + 5 h.
    expect(uptime("Old").day).toBeCloseTo(1 - 1.5 / 24, 10);
    expect(uptime("Old").week).toBeCloseTo(1 - 7.5 / 168, 10);
    expect(uptime("Old").month).toBeCloseTo(1 - 24.5 / 720, 10);
    // Counted from its creation, 6 hours ago, in every period.
    expect(uptime("Young").day).toBeCloseTo(5 / 6, 10);
    expect(uptime("Young").week).toBeCloseTo(5 / 6, 10);
    expect(uptime("Steady")).toEqual({ day: 1, week: 1, month: 1 });
  });
});

describe("a check's page", () => {
  test("charts response times in buckets, counts runs and failures, and lists the latest failures", async () => {
    const check = await insertCheck();
    const other = await insertCheck({ name: "Other" });
    const target = { id: check.id, projectId };
    await storeResult(
      dashboard.reader.client,
      target,
      outcome({ responseMs: 100 }),
      at("08:00:10"),
    );
    await storeResult(
      dashboard.reader.client,
      target,
      outcome({ responseMs: 300 }),
      at("08:02:00"),
    );
    await storeResult(
      dashboard.reader.client,
      target,
      outcome({
        up: false,
        statusCode: 503,
        responseMs: 50,
        cause: "status",
        detail: "It answered 503.",
      }),
      at("09:00:00"),
    );
    await storeResult(
      dashboard.reader.client,
      target,
      outcome({
        up: false,
        statusCode: null,
        responseMs: 10_000,
        cause: "timeout",
        detail: "Slow.",
      }),
      at("09:05:00"),
    );
    // Another check's result, and one after now: neither counts.
    await storeResult(
      dashboard.reader.client,
      { id: other.id, projectId },
      outcome({ responseMs: 9999 }),
      at("08:00:00"),
    );
    // An incident of 10:00 to 11:00, and one open since 11:30.
    await insertIncident(check.id, { started_at: at("10:00:00"), ended_at: at("11:00:00") });
    await insertIncident(check.id, { started_at: at("11:30:00"), cause: "timeout" });

    const response = await call("GET", `/checks/${check.id}/results?period=today`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // 00:00 to now, 12:00, in 5-minute buckets.
    expect(body).toMatchObject({
      timeZone: "UTC",
      firstDay: YESTERDAY,
      lastDay: YESTERDAY,
      retentionDays: 90,
      start: at("00:00:00").toISOString(),
      stepSeconds: 300,
      buckets: 144,
      runs: 4,
      failures: 2,
    });
    // 08:00 holds 100 ms and 300 ms; 09:00 the 503's 50 ms; 09:05 nothing that answered.
    const filled = body.responseMs.flatMap((value: number | null, index: number) =>
      value === null ? [] : [[index, value]],
    );
    expect(filled).toEqual([
      [96, 200],
      [108, 50],
    ]);
    expect(body.latestFailures).toEqual([
      {
        at: at("09:05:00").toISOString(),
        statusCode: null,
        responseMs: 10_000,
        cause: "timeout",
        detail: "Slow.",
      },
      {
        at: at("09:00:00").toISOString(),
        statusCode: 503,
        responseMs: 50,
        cause: "status",
        detail: "It answered 503.",
      },
    ]);
    // 12 hours of the day so far: 1 hour down, and 30 minutes of the open one.
    expect(body.uptime).toBeCloseTo(1 - 1.5 / 12, 10);

    const incidents = (await call("GET", `/checks/${check.id}/incidents?period=today`)).json();
    expect(incidents).toMatchObject({ truncated: false });
    expect(incidents.incidents).toEqual([
      {
        id: expect.any(String),
        startedAt: at("11:30:00").toISOString(),
        endedAt: null,
        cause: "timeout",
        detail: "",
      },
      {
        id: expect.any(String),
        startedAt: at("10:00:00").toISOString(),
        endedAt: at("11:00:00").toISOString(),
        cause: "status",
        detail: "",
      },
    ]);
  });

  test("refuses a bad range and an unknown check", async () => {
    const check = await insertCheck();
    const bad = await call("GET", `/checks/${check.id}/results?from=2026-11-10&to=2026-11-01`);
    expect([bad.statusCode, bad.json().error]).toEqual([400, "invalid_range"]);
    const unknown = await call(
      "GET",
      "/checks/00000000-0000-4000-8000-000000000000/results?period=7d",
    );
    expect([unknown.statusCode, unknown.json().error]).toEqual([404, "check_not_found"]);
    expect((await call("GET", `/checks/${check.id}/results?environment=staging`)).statusCode).toBe(
      400,
    );
  });
});

describe("another organization", () => {
  test("cannot see or reach a project's checks through its own project", async () => {
    const check = await insertCheck();
    const bob = await signedInUser(
      dashboard,
      { name: "Bob", email: "bob-uptime@example.com" },
      { newOrganization: "Bob's shop" },
    );
    const bobProject = await insertProject(dashboard.db, {
      organization_id: bob.organizationId ?? "",
      name: "Bob's site",
    });
    // Ada's check ID under Bob's own project: not his check.
    for (const [method, path] of [
      ["GET", ""],
      ["GET", "/results?period=7d"],
      ["GET", "/incidents?period=7d"],
      ["PATCH", ""],
      ["DELETE", ""],
    ] as const) {
      const response = await dashboard.app.inject({
        method,
        url: `/api/projects/${bobProject.id}/checks/${check.id}${path}`,
        headers: { cookie: bob.cookie, origin: PUBLIC_URL },
        ...(method === "PATCH" ? { payload: { paused: true } } : {}),
      });
      expect([method, path, response.statusCode]).toEqual([method, path, 404]);
    }
    expect((await call("GET", `/checks/${check.id}`)).json().check.paused).toBe(false);
  });
});
