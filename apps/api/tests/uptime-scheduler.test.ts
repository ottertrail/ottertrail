import type { Insertable } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { QueryParams, queryRows } from "../src/clickhouse/query.ts";
import type { UptimeChecksTable } from "../src/db/schema.ts";
import {
  recordOutcome,
  type StateChange,
  takeDueChecks,
  updateCheck,
  valuesOfCheck,
  checkOf,
} from "../src/uptime/checks.ts";
import type { CheckOutcome } from "../src/uptime/request.ts";
import { CheckScheduler } from "../src/uptime/scheduler.ts";
import { insertProject } from "./helpers/projects.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";
import { startUptimeServers, testLookup, type UptimeServers } from "./helpers/uptime-servers.ts";

let testDb: TestDatabase;
let testClickHouse: TestClickHouse;
let servers: UptimeServers;
let projectId = "";
let changes: StateChange[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  testClickHouse = await createTestClickHouse();
  servers = await startUptimeServers();
  projectId = (await insertProject(testDb.db, { name: "Shop" })).id;
});

afterAll(async () => {
  await servers?.close();
  await testClickHouse?.destroy();
  await testDb?.destroy();
});

beforeEach(async () => {
  await testDb.db.deleteFrom("uptime_checks").execute();
  servers.flaky.status = 200;
  changes = [];
});

function scheduler(
  more: {
    maxRunning?: number;
    maxRunningPerProject?: number;
    now?: () => Date;
    takeAt?: () => Date;
    log?: (level: "info" | "error", msg: string, fields?: Record<string, unknown>) => void;
    policy?: { allowPrivate: boolean };
  } = {},
) {
  return new CheckScheduler({
    db: testDb.db,
    clickhouse: testClickHouse.client,
    // The test servers are on loopback.
    policy: { allowPrivate: true },
    lookup: testLookup(),
    ca: servers.certificate.cert,
    onStateChange: (change) => {
      changes.push(change);
    },
    ...more,
  });
}

async function insertCheck(values: Partial<Insertable<UptimeChecksTable>> = {}) {
  return testDb.db
    .insertInto("uptime_checks")
    .values({
      project_id: projectId,
      name: "Health",
      url: `${servers.http}/flaky`,
      method: "GET",
      interval_seconds: 60,
      timeout_seconds: 5,
      expected_statuses: "200-399",
      word_mode: "present",
      failures_before_down: 2,
      next_due_at: new Date(Date.now() - 1000),
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

const checkRow = (id: string) =>
  testDb.db.selectFrom("uptime_checks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const incidentsOf = (id: string) =>
  testDb.db
    .selectFrom("uptime_incidents")
    .selectAll()
    .where("check_id", "=", id)
    .orderBy("started_at")
    .execute();

/** Takes the check and runs it now, as a tick does, and waits for it. */
async function runNow(id: string, runner = scheduler()) {
  await testDb.db
    .updateTable("uptime_checks")
    .set({ next_due_at: new Date(Date.now() - 1000) })
    .where("id", "=", id)
    .execute();
  await runner.tick();
  await runner.drain();
  return checkRow(id);
}

describe("an uptime check's state", () => {
  test("is up after a success, with its latest answer, and its result is in ClickHouse", async () => {
    const check = await insertCheck();
    const row = await runNow(check.id);
    expect(row).toMatchObject({
      state: "up",
      consecutive_failures: 0,
      last_up: true,
      last_status_code: 200,
      last_cause: null,
    });
    expect(row.last_checked_at).not.toBeNull();
    expect(changes).toEqual([]);
    const params = new QueryParams();
    const rows = await queryRows<{ up: boolean; status_code: number; cause: string }>(
      { client: testClickHouse.client },
      `SELECT up, status_code, cause FROM check_results
       WHERE project_id = ${params.add(projectId, "UUID")} AND check_id = ${params.add(check.id, "UUID")}`,
      params,
    );
    expect(rows).toEqual([{ up: true, status_code: 200, cause: "" }]);
  });

  test("goes down after N failures in a row, with one incident from the first", async () => {
    const check = await insertCheck({ failures_before_down: 2 });
    await runNow(check.id);
    servers.flaky.status = 503;

    const once = await runNow(check.id);
    expect(once).toMatchObject({ state: "up", consecutive_failures: 1, failing_cause: "status" });
    expect(await incidentsOf(check.id)).toEqual([]);

    const twice = await runNow(check.id);
    expect(twice).toMatchObject({ state: "down", consecutive_failures: 2, last_status_code: 503 });
    const [incident, ...others] = await incidentsOf(check.id);
    expect(others).toEqual([]);
    expect(incident).toMatchObject({
      ended_at: null,
      cause: "status",
      detail: "It answered 503, which does not count as up.",
    });
    // The incident starts at the first failure of the run, not the one that took it down.
    expect(incident?.started_at).toEqual(once.failing_since);
    expect(changes).toMatchObject([{ checkId: check.id, from: "up", to: "down", cause: "status" }]);

    // Still down: no second incident.
    await runNow(check.id);
    expect(await incidentsOf(check.id)).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });

  test("comes back up after one success, which ends the incident", async () => {
    const check = await insertCheck({ failures_before_down: 1 });
    servers.flaky.status = 500;
    expect(await runNow(check.id)).toMatchObject({ state: "down" });
    expect(changes).toMatchObject([{ from: "pending", to: "down" }]);
    servers.flaky.status = 200;
    const row = await runNow(check.id);
    expect(row).toMatchObject({ state: "up", consecutive_failures: 0, failing_since: null });
    const [incident] = await incidentsOf(check.id);
    expect(incident?.ended_at).toEqual(row.last_checked_at);
    expect(changes).toMatchObject([
      { to: "down" },
      { from: "down", to: "up", incidentId: incident?.id },
    ]);
    // A new failure run is a new incident.
    servers.flaky.status = 500;
    await runNow(check.id);
    expect(await incidentsOf(check.id)).toHaveLength(2);
  });

  test("records the HTTPS certificate's expiry", async () => {
    const check = await insertCheck({ url: `${servers.https}/ok` });
    const row = await runNow(check.id);
    expect(row).toMatchObject({ state: "up", tls_expires_at: servers.certificate.notAfter });
  });

  test("records nothing for a check paused while it ran", async () => {
    const check = await insertCheck({ url: `${servers.http}/hook` });
    servers.onHook.run = async () => {
      await testDb.db
        .updateTable("uptime_checks")
        .set({ paused: true })
        .where("id", "=", check.id)
        .execute();
    };
    try {
      const row = await runNow(check.id);
      expect(row).toMatchObject({ paused: true, state: "pending", last_checked_at: null });
    } finally {
      servers.onHook.run = async () => undefined;
    }
  });
});

describe("scheduling", () => {
  test("two workers taking at once each get different checks, and each check once", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => insertCheck()));
    const now = new Date();
    const [first, second] = await Promise.all([
      takeDueChecks(testDb.db, { now: now, limit: 20, perProject: 20 }),
      takeDueChecks(testDb.db, { now: now, limit: 20, perProject: 20 }),
    ]);
    const taken = [...(first ?? []), ...(second ?? [])].map((check) => check.id);
    expect(taken.toSorted()).toEqual(ids.map((check) => check.id).toSorted());
    // Taken again at the same moment: nothing is due any more.
    expect(await takeDueChecks(testDb.db, { now: now, limit: 20, perProject: 20 })).toEqual([]);
  });

  test("moves the next due time on before the request is made", async () => {
    const check = await insertCheck({ url: `${servers.http}/hook` });
    const seen: Date[] = [];
    servers.onHook.run = async () => {
      seen.push((await checkRow(check.id)).next_due_at);
    };
    try {
      const started = new Date();
      await runNow(check.id);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.getTime()).toBeGreaterThan(started.getTime());
    } finally {
      servers.onHook.run = async () => undefined;
    }
  });

  test("a crash after taking a check skips that run, and it is due again one interval later", async () => {
    const due = new Date("2026-11-18T10:00:00.000Z");
    const check = await insertCheck({ next_due_at: due, interval_seconds: 60 });
    const now = new Date("2026-11-18T10:00:30.000Z");
    // The worker takes it, then dies before running it.
    expect(await takeDueChecks(testDb.db, { now: now, limit: 20, perProject: 20 })).toHaveLength(1);
    // A restarted worker does not take it again at once: no loop.
    expect(await takeDueChecks(testDb.db, { now: now, limit: 20, perProject: 20 })).toEqual([]);
    expect((await checkRow(check.id)).next_due_at).toEqual(new Date("2026-11-18T10:01:00.000Z"));
    const later = await takeDueChecks(testDb.db, {
      now: new Date("2026-11-18T10:01:05.000Z"),
      limit: 20,
      perProject: 20,
    });
    expect(later.map((taken) => taken.id)).toEqual([check.id]);
  });

  test("keeps a check's place in its interval after the worker was away", async () => {
    const check = await insertCheck({
      next_due_at: new Date("2026-11-18T10:00:10.000Z"),
      interval_seconds: 300,
    });
    // Down for 22 minutes: the run is taken once, and the next is at :10 past a 5-minute mark.
    await takeDueChecks(testDb.db, {
      now: new Date("2026-11-18T10:22:00.000Z"),
      limit: 20,
      perProject: 20,
    });
    expect((await checkRow(check.id)).next_due_at).toEqual(new Date("2026-11-18T10:25:10.000Z"));
  });

  test("never takes a paused check", async () => {
    await insertCheck({ paused: true });
    expect(await takeDueChecks(testDb.db, { now: new Date(), limit: 20, perProject: 20 })).toEqual(
      [],
    );
  });

  test("runs at most its limit at once, and takes more as they finish", async () => {
    await Promise.all(
      Array.from({ length: 3 }, () =>
        insertCheck({ url: `${servers.http}/slow`, timeout_seconds: 1 }),
      ),
    );
    const runner = scheduler({ maxRunning: 2 });
    expect(await runner.tick()).toBe(2);
    expect(runner.running).toBe(2);
    expect(await runner.tick()).toBe(0);
    await runner.drain();
    expect(await runner.tick()).toBe(1);
    await runner.drain();
    const rows = await testDb.db.selectFrom("uptime_checks").select("last_cause").execute();
    expect(rows.map((row) => row.last_cause)).toEqual(["timeout", "timeout", "timeout"]);
  });
});

const UP: CheckOutcome = {
  up: true,
  statusCode: 200,
  responseMs: 20,
  cause: null,
  detail: "",
  tlsExpiresAt: null,
};
const DOWN: CheckOutcome = { ...UP, up: false, statusCode: 500, cause: "status", detail: "500" };

describe("sharing the worker", () => {
  test("one project runs at most its share of the places at once", async () => {
    const other = (await insertProject(testDb.db, { name: "Other" })).id;
    await Promise.all([
      ...Array.from({ length: 4 }, () =>
        insertCheck({ url: `${servers.http}/slow`, timeout_seconds: 1 }),
      ),
      ...Array.from({ length: 2 }, () =>
        insertCheck({ project_id: other, url: `${servers.http}/slow`, timeout_seconds: 1 }),
      ),
    ]);
    const runner = scheduler({ maxRunning: 4, maxRunningPerProject: 2 });
    expect(await runner.tick()).toBe(4);
    const running = await testDb.db
      .selectFrom("uptime_checks")
      .select(["project_id"])
      .where("next_due_at", ">", new Date())
      .execute();
    expect(running.filter((row) => row.project_id === other)).toHaveLength(2);
    expect(running.filter((row) => row.project_id === projectId)).toHaveLength(2);
    // Full: the first project's other two wait for its own places, not anyone's.
    expect(await runner.tick()).toBe(0);
    await runner.drain();
    expect(await runner.tick()).toBe(2);
    await runner.drain();
  });

  test("logs once when checks are taken late, and once when they are on time again", async () => {
    const logged: string[] = [];
    const runner = scheduler({ log: (_level, msg) => logged.push(msg) });
    const late = async () => {
      await insertCheck({ url: `${servers.http}/ok`, next_due_at: new Date(Date.now() - 60_000) });
      await runner.tick();
      await runner.drain();
    };
    await late();
    await late();
    expect(logged.filter((msg) => msg.startsWith("uptime checks are running late"))).toHaveLength(
      1,
    );
    await insertCheck({ url: `${servers.http}/ok` });
    await runner.tick();
    await runner.drain();
    expect(logged).toContain("uptime checks run on time again");
  });

  test("brings a next due time from a clock that jumped ahead back to one interval from now", async () => {
    const check = await insertCheck({
      interval_seconds: 60,
      next_due_at: new Date(Date.now() + 365 * 86_400_000),
    });
    await takeDueChecks(testDb.db, { limit: 20, perProject: 20 });
    const due = (await checkRow(check.id)).next_due_at.getTime();
    expect(due).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  test("logs a refused address, which the check's own detail does not name", async () => {
    const logged: Record<string, unknown>[] = [];
    const check = await insertCheck({ url: `${servers.http}/ok` });
    const row = await runNow(
      check.id,
      scheduler({
        policy: { allowPrivate: false },
        log: (_level, msg, fields) => logged.push({ msg, ...fields }),
      }),
    );
    expect(row.last_cause).toBe("address");
    expect(row.failing_detail).toBe("status.test resolves to an address checks may not reach.");
    expect(logged).toContainEqual(
      expect.objectContaining({
        msg: "an uptime check's address was refused",
        host: "status.test",
        address: "127.0.0.1",
        kind: "loopback",
      }),
    );
  });
});

describe("recording outcomes", () => {
  test("never records a run that started before the latest recorded one", async () => {
    const check = await insertCheck({ failures_before_down: 1 });
    const later = new Date(Date.now() - 1000);
    expect(await recordOutcome(testDb.db, check.id, UP, later)).toBeNull();
    // An earlier run that finished after it, as when an edit overlapped two runs.
    expect(
      await recordOutcome(testDb.db, check.id, DOWN, new Date(later.getTime() - 5000)),
    ).toBeNull();
    expect(await checkRow(check.id)).toMatchObject({ state: "up", last_checked_at: later });
    expect(await incidentsOf(check.id)).toEqual([]);
  });

  test("a new URL starts afresh: no state, failures, incident, or certificate of the old one", async () => {
    const check = await insertCheck({ url: `${servers.https}/ok`, failures_before_down: 1 });
    const before = new Date(Date.now() - 2000);
    await recordOutcome(
      testDb.db,
      check.id,
      { ...DOWN, tlsExpiresAt: new Date("2030-01-01") },
      before,
    );
    expect(await checkRow(check.id)).toMatchObject({ state: "down", consecutive_failures: 1 });
    const current = checkOf(await checkRow(check.id));
    const edited = await updateCheck(
      testDb.db,
      projectId,
      check.id,
      { ...valuesOfCheck(current), url: `${servers.http}/ok` },
      undefined,
      new Date(),
    );
    expect(edited).toMatchObject({
      state: "pending",
      consecutiveFailures: 0,
      failingSince: null,
      tlsExpiresAt: null,
    });
    const [incident] = await incidentsOf(check.id);
    expect(incident?.ended_at).not.toBeNull();
    // A run of the old URL, started before the change, is not recorded.
    expect(await recordOutcome(testDb.db, check.id, DOWN, new Date(Date.now() - 1000))).toBeNull();
    expect(await checkRow(check.id)).toMatchObject({ state: "pending", consecutive_failures: 0 });
    // Changing only the name keeps the state.
    await updateCheck(
      testDb.db,
      projectId,
      check.id,
      { ...valuesOfCheck(checkOf(await checkRow(check.id))), name: "Renamed" },
      undefined,
      new Date(),
    );
    expect(await recordOutcome(testDb.db, check.id, DOWN, new Date(Date.now() + 10))).toMatchObject(
      {
        to: "down",
      },
    );
  });
});
