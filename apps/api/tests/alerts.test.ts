import { randomUUID } from "node:crypto";

import { type Insertable, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { evaluateCertificates, evaluateCheckDown } from "../src/alerts/check-rules.ts";
import { ARRIVAL_LAG_MS, evaluateErrorRules, MAX_CATCH_UP_MS } from "../src/alerts/error-rules.ts";
import { AlertEvaluator } from "../src/alerts/evaluator.ts";
import { type AlertContext, flushHeldBack, RULE_HOURLY_CAP } from "../src/alerts/fire.ts";
import type { RuleKind } from "../src/alerts/kinds.ts";
import {
  endOrphanedCheckAlerts,
  findRule,
  pruneHistory,
  updateRule,
  valuesOfRule,
} from "../src/alerts/rules.ts";
import { type NewEvent, storeEvents } from "../src/collection/event-store.ts";
import type { UptimeChecksTable } from "../src/db/schema.ts";
import { setResolution } from "../src/errors/errors.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import { isPayload, type NotificationPayload } from "../src/notifications/events.ts";
import { deleteCheck, recordOutcome } from "../src/uptime/checks.ts";
import type { CheckOutcome } from "../src/uptime/request.ts";
import { CheckScheduler } from "../src/uptime/scheduler.ts";
import { insertProject } from "./helpers/projects.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";
import { startUptimeServers, testLookup, type UptimeServers } from "./helpers/uptime-servers.ts";

/**
 * Alert rules evaluated against real PostgreSQL and ClickHouse
 * (docs/uptime-alerts.md, "Alerts"): every kind fires once, and not again
 * after a restart; resolves where its kind resolves; and sends through
 * notify, so each notification is a delivery with its type and payload.
 */

const PUBLIC = "https://ottertrail.example.com";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The clock of these tests: a whole minute, a little in the past. */
const NOW = new Date(Math.floor((Date.now() - 2 * HOUR) / MINUTE) * MINUTE);
const later = (ms: number) => new Date(NOW.getTime() + ms);

let testDb: TestDatabase;
let testClickHouse: TestClickHouse;
let context: AlertContext;
let channelId = "";
let projectId = "";

beforeAll(async () => {
  testDb = await createTestDatabase();
  testClickHouse = await createTestClickHouse();
  context = { db: testDb.db, publicUrl: PUBLIC };
});

afterAll(async () => {
  await testClickHouse?.destroy();
  await testDb?.destroy();
});

beforeEach(async () => {
  await testDb.db.deleteFrom("alert_rules").execute();
  await testDb.db.deleteFrom("alert_evaluations").execute();
  await testDb.db.deleteFrom("notification_channels").execute();
  const channel = await testDb.db
    .insertInto("notification_channels")
    .values({
      name: "Team",
      kind: "webhook",
      webhook_url: "https://hooks.example.com/ottertrail",
      // Made at run time: no literal that looks like a key.
      webhook_secret: "x".repeat(43),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  channelId = channel.id;
  // A project of its own per test: ClickHouse's events stay apart.
  projectId = (await insertProject(testDb.db, { name: "Shop" })).id;
});

async function insertRule(kind: RuleKind, settings: object = {}, createdAt = NOW) {
  const row = await testDb.db
    .insertInto("alert_rules")
    .values({
      project_id: projectId,
      name: `Rule ${kind}`,
      kind,
      settings: JSON.stringify(settings),
      channel_ids: [channelId],
      active_since: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertCheck(values: Partial<Insertable<UptimeChecksTable>> = {}) {
  return testDb.db
    .insertInto("uptime_checks")
    .values({
      project_id: projectId,
      name: "API health",
      url: "https://api.shop.example/health",
      method: "GET",
      interval_seconds: 60,
      timeout_seconds: 10,
      expected_statuses: "200-399",
      word_mode: "present",
      failures_before_down: 2,
      next_due_at: NOW,
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The project's notifications, oldest first, as their deliveries hold them. */
async function sent(): Promise<NotificationPayload[]> {
  const rows = await testDb.db
    .selectFrom("notification_deliveries")
    .select(["event_type", "payload", "created_at"])
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows
    .map((row) => {
      if (!isPayload(row.payload)) throw new Error("not a payload");
      expect(row.event_type).toBe(row.payload.type);
      return row.payload;
    })
    .filter((payload) => payload.project?.id === projectId);
}

const historyOf = (ruleId: string) =>
  testDb.db
    .selectFrom("alert_history")
    .selectAll()
    .where("rule_id", "=", ruleId)
    .orderBy("fired_at")
    .orderBy("message")
    .execute();

const DOWN: CheckOutcome = {
  up: false,
  statusCode: 503,
  responseMs: 40,
  cause: "status",
  detail: "It answered 503, which does not count as up.",
  tlsExpiresAt: null,
};
const UP: CheckOutcome = { ...DOWN, up: true, statusCode: 200, cause: null, detail: "" };

const reader = () => ({ client: testClickHouse.client });

/** An error event that happened at `occurredAt` and arrives at `receivedAt`. */
async function arrive(
  error: { type: string; message: string },
  occurredAt: Date,
  receivedAt: Date,
  more: Partial<NewEvent> = {},
) {
  await storeEvents(
    testClickHouse.client,
    projectId,
    [
      {
        eventId: randomUUID(),
        name: "error",
        occurredAt,
        path: "/cart",
        visitorId: "1",
        error: { ...error, handled: false, fingerprint: fingerprint(error) },
        ...more,
      },
    ],
    { receivedAt },
  );
}

describe("check down", () => {
  test("fires through recordOutcome's change, once, and resolves when the check is up", async () => {
    const check = await insertCheck({ state: "up" });
    const ruleId = await insertRule("check_down", { checkId: null });
    let clock = later(2 * MINUTE);
    const alerts = new AlertEvaluator({
      ...context,
      clickhouse: testClickHouse.client,
      now: () => clock,
    });

    expect(await recordOutcome(testDb.db, check.id, DOWN, later(MINUTE))).toBeNull();
    const change = await recordOutcome(testDb.db, check.id, DOWN, later(2 * MINUTE));
    expect(change?.to).toBe("down");
    if (change === null) return;
    await alerts.onStateChange(change);

    const [down] = await sent();
    expect(await sent()).toHaveLength(1);
    expect(down).toMatchObject({
      type: "check.down",
      project: { id: projectId, name: "Shop" },
      subject: {
        type: "check",
        id: check.id,
        name: "API health",
        url: "https://api.shop.example/health",
        ruleId,
        ruleName: "Rule check_down",
      },
      message:
        'Shop: the check "API health" (https://api.shop.example/health) is down. It answered 503, which does not count as up.',
      url: `${PUBLIC}/projects/${projectId}/uptime/${check.id}`,
    });

    // The same change again, a restart's catch-up, a new worker's tick: nothing more.
    await alerts.onStateChange(change);
    await evaluateCheckDown(context, {}, later(3 * MINUTE));
    await new AlertEvaluator({
      ...context,
      clickhouse: testClickHouse.client,
      now: () => later(4 * MINUTE),
    }).tick();
    expect(await sent()).toHaveLength(1);

    clock = later(30 * MINUTE);
    const up = await recordOutcome(testDb.db, check.id, UP, clock);
    expect(up?.to).toBe("up");
    if (up === null) return;
    await alerts.onStateChange(up);
    const notifications = await sent();
    expect(notifications.map((payload) => payload.type)).toEqual(["check.down", "check.up"]);
    expect(notifications[1]?.message).toBe(
      'Shop: the check "API health" (https://api.shop.example/health) is up again, after 29 minutes down.',
    );
    const [entry] = await historyOf(ruleId);
    expect(entry).toMatchObject({ subject: check.id, subject_name: "API health" });
    expect(entry?.notification_id).toBe(down?.id);
    expect(entry?.resolved_at).toEqual(later(2 * MINUTE + 28 * MINUTE));
    expect(entry?.resolve_notification_id).toBe(notifications[1]?.id);
  });

  test("misses nothing: a change the worker did not act on fires on the next tick", async () => {
    const check = await insertCheck({ state: "up", failures_before_down: 1 });
    const other = await insertCheck({ name: "Shop home", url: "https://shop.example/" });
    await insertRule("check_down", { checkId: check.id });
    // The worker stopped between recording the change and acting on it.
    await recordOutcome(testDb.db, check.id, DOWN, later(MINUTE));
    await recordOutcome(testDb.db, other.id, DOWN, later(MINUTE));
    await recordOutcome(testDb.db, other.id, DOWN, later(2 * MINUTE));
    await new AlertEvaluator({
      ...context,
      clickhouse: testClickHouse.client,
      now: () => later(3 * MINUTE),
    }).tick();
    // Only the check the rule names.
    expect((await sent()).map((payload) => [payload.type, payload.subject.id])).toEqual([
      ["check.down", check.id],
    ]);
  });

  test("a paused check's alert resolves, and a rule turned off sends nothing", async () => {
    const check = await insertCheck({ state: "down" });
    const ruleId = await insertRule("check_down", { checkId: null });
    await evaluateCheckDown(context, {}, NOW);
    await testDb.db
      .updateTable("uptime_checks")
      .set({ paused: true, state: "pending" })
      .where("id", "=", check.id)
      .execute();
    await evaluateCheckDown(context, {}, later(MINUTE));
    expect((await sent()).map((payload) => payload.message)).toEqual([
      'Shop: the check "API health" (https://api.shop.example/health) is down.',
      'Shop: the check "API health" (https://api.shop.example/health) is no longer down: it was paused, or its URL changed.',
    ]);
    await testDb.db
      .updateTable("alert_rules")
      .set({ enabled: false })
      .where("id", "=", ruleId)
      .execute();
    await testDb.db
      .updateTable("uptime_checks")
      .set({ paused: false, state: "down" })
      .where("id", "=", check.id)
      .execute();
    await evaluateCheckDown(context, {}, later(2 * MINUTE));
    expect(await sent()).toHaveLength(2);
  });
});

describe("certificate expiring", () => {
  const DAY = 24 * HOUR;

  test("fires once per expiry date within the days, and resolves when renewed", async () => {
    const check = await insertCheck({ tls_expires_at: later(10 * DAY) });
    await insertCheck({
      name: "Far",
      url: "https://far.example/",
      tls_expires_at: later(60 * DAY),
    });
    const ruleId = await insertRule("certificate_expiring", { checkId: null, days: 14 });

    await evaluateCertificates(context, {}, NOW);
    await evaluateCertificates(context, {}, later(HOUR));
    let notifications = await sent();
    expect(notifications).toHaveLength(1);
    const day = later(10 * DAY)
      .toISOString()
      .slice(0, 10);
    expect(notifications[0]).toMatchObject({
      type: "certificate.expiring",
      subject: {
        type: "certificate",
        checkId: check.id,
        host: "api.shop.example",
        expiresAt: later(10 * DAY).toISOString(),
        days: 14,
      },
      message: `Shop: the TLS certificate of api.shop.example, checked by "API health", expires on ${day}, in 10 days.`,
    });

    // Renewed: the expiry moved past the window.
    await testDb.db
      .updateTable("uptime_checks")
      .set({ tls_expires_at: later(90 * DAY) })
      .where("id", "=", check.id)
      .execute();
    await evaluateCertificates(context, {}, later(2 * HOUR));
    notifications = await sent();
    expect(notifications.map((payload) => payload.type)).toEqual([
      "certificate.expiring",
      "certificate.renewed",
    ]);

    // Another certificate, also close to its end: it fires again, for its own date.
    await testDb.db
      .updateTable("uptime_checks")
      .set({ tls_expires_at: later(3 * DAY) })
      .where("id", "=", check.id)
      .execute();
    await evaluateCertificates(context, {}, later(3 * HOUR));
    await evaluateCertificates(context, {}, later(4 * HOUR));
    expect((await sent()).map((payload) => payload.type)).toEqual([
      "certificate.expiring",
      "certificate.renewed",
      "certificate.expiring",
    ]);
    expect(await historyOf(ruleId)).toHaveLength(2);
  });

  test("the checker's hook: a run that sees a new certificate evaluates the check's rules", async () => {
    const servers: UptimeServers = await startUptimeServers();
    try {
      const check = await insertCheck({ url: `${servers.https}/ok`, next_due_at: new Date(0) });
      await insertRule("certificate_expiring", { checkId: check.id, days: 90 });
      // The test certificate ends on servers.certificate.notAfter: 30 days before it.
      const at = new Date(servers.certificate.notAfter.getTime() - 30 * DAY);
      const alerts = new AlertEvaluator({
        ...context,
        clickhouse: testClickHouse.client,
        now: () => at,
      });
      const seen: Date[] = [];
      const scheduler = new CheckScheduler({
        db: testDb.db,
        clickhouse: testClickHouse.client,
        policy: { allowPrivate: true },
        lookup: testLookup(),
        ca: servers.certificate.cert,
        onCertificate: async (found) => {
          seen.push(found.expiresAt);
          await alerts.onCertificate(found);
        },
      });
      await scheduler.tick();
      await scheduler.drain();
      expect(seen).toEqual([servers.certificate.notAfter]);
      const [notification] = await sent();
      expect(notification).toMatchObject({
        type: "certificate.expiring",
        subject: { checkId: check.id, expiresAt: servers.certificate.notAfter.toISOString() },
      });
      // The same certificate on the next run: no new expiry, no hook.
      await testDb.db
        .updateTable("uptime_checks")
        .set({ next_due_at: new Date(0) })
        .where("id", "=", check.id)
        .execute();
      await scheduler.tick();
      await scheduler.drain();
      expect(seen).toHaveLength(1);
      expect(await sent()).toHaveLength(1);
    } finally {
      await servers.close();
    }
  });
});

const CART = {
  type: "TypeError",
  message: "Cannot read properties of undefined (reading 'total')",
};
const PAYMENT = { type: "Error", message: "Payment declined" };
const STAGING_ONLY = { type: "RangeError", message: "Invalid array length" };

describe("new error", () => {
  test("fires once per group first seen after the rule existed, in its environment", async () => {
    const ruleId = await insertRule("error_new", { environment: "production" }, NOW);
    const allId = await insertRule("error_new", { environment: null }, later(1));
    // Seen before the rule existed: not new, even if it happens again now.
    await arrive(PAYMENT, later(-HOUR), later(-HOUR));
    await arrive(PAYMENT, later(MINUTE), later(MINUTE));
    await arrive(CART, later(MINUTE), later(MINUTE));
    await arrive(CART, later(2 * MINUTE), later(2 * MINUTE));
    await arrive(STAGING_ONLY, later(2 * MINUTE), later(2 * MINUTE), { environment: "staging" });

    const at = later(3 * MINUTE);
    const [pass] = await evaluateErrorRules(context, reader(), at);
    expect(pass?.until).toEqual(new Date(at.getTime() - ARRIVAL_LAG_MS));

    const notifications = await sent();
    expect(
      notifications.map((payload) => [payload.subject.ruleId, payload.subject.errorType]),
    ).toEqual([
      [ruleId, "TypeError"],
      [allId, "TypeError"],
      [allId, "RangeError"],
    ]);
    expect(notifications[0]).toMatchObject({
      type: "error.new",
      subject: {
        type: "error",
        fingerprint: fingerprint(CART),
        errorType: "TypeError",
        message: CART.message,
        environment: "production",
      },
      message: `Shop: a new error in production. TypeError: ${CART.message}`,
      url: `${PUBLIC}/projects/${projectId}/errors/${fingerprint(CART)}?env=%22production%22`,
    });

    // A restart that lost the evaluation's end reads the same window again: nothing twice.
    await testDb.db.deleteFrom("alert_evaluations").execute();
    await evaluateErrorRules(context, reader(), later(4 * MINUTE));
    await arrive(CART, later(5 * MINUTE), later(5 * MINUTE));
    await evaluateErrorRules(context, reader(), later(6 * MINUTE));
    expect(await sent()).toHaveLength(3);
    const history = await historyOf(ruleId);
    expect(history.map((entry) => [entry.subject, entry.resolved_at])).toEqual([
      [fingerprint(CART), null],
    ]);
  });
});

describe("regressed error", () => {
  test("fires once when a resolved group happens again, and again after another resolution", async () => {
    const ruleId = await insertRule("error_regressed", {}, later(-2 * HOUR));
    const userId = (
      await testDb.db
        .insertInto("dashboard_users")
        .values({ name: "Ada", email: `${randomUUID()}@example.com` })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await arrive(CART, later(-HOUR), later(-HOUR));
    await setResolution(testDb.db, {
      projectId,
      fingerprint: fingerprint(CART),
      resolved: true,
      userId,
    });
    const { resolved_at: resolvedAt } = await testDb.db
      .selectFrom("error_resolutions")
      .select("resolved_at")
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow();

    // Seen again after the resolution (the real clock: resolutions use now()).
    const again = new Date(Math.max(resolvedAt.getTime(), NOW.getTime()) + MINUTE);
    await arrive(CART, again, again, { environment: "staging" });
    await evaluateErrorRules(context, reader(), new Date(again.getTime() + 2 * MINUTE));
    await arrive(
      CART,
      new Date(again.getTime() + 3 * MINUTE),
      new Date(again.getTime() + 3 * MINUTE),
    );
    await evaluateErrorRules(context, reader(), new Date(again.getTime() + 5 * MINUTE));

    let notifications = await sent();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "error.regressed",
      subject: {
        fingerprint: fingerprint(CART),
        environment: "staging",
        resolvedAt: resolvedAt.toISOString(),
      },
      message: `Shop: an error resolved on ${resolvedAt.toISOString().slice(0, 10)} happened again, in staging. TypeError: ${CART.message}`,
    });

    // Resolved again, and back once more: a new regression.
    await testDb.db
      .updateTable("error_resolutions")
      .set({ resolved_at: new Date(again.getTime() + 6 * MINUTE) })
      .where("project_id", "=", projectId)
      .execute();
    const third = new Date(again.getTime() + 8 * MINUTE);
    await arrive(CART, third, third);
    await evaluateErrorRules(context, reader(), new Date(third.getTime() + 2 * MINUTE));
    notifications = await sent();
    expect(notifications.map((payload) => payload.type)).toEqual([
      "error.regressed",
      "error.regressed",
    ]);
    expect(await historyOf(ruleId)).toHaveLength(2);
  });

  test("an occurrence before the resolution is not a regression", async () => {
    await insertRule("error_regressed", {}, later(-2 * HOUR));
    const userId = (
      await testDb.db
        .insertInto("dashboard_users")
        .values({ name: "Bo", email: `${randomUUID()}@example.com` })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await setResolution(testDb.db, {
      projectId,
      fingerprint: fingerprint(PAYMENT),
      resolved: true,
      userId,
    });
    // It happened before it was resolved, and arrives only now.
    await arrive(PAYMENT, later(-HOUR), later(MINUTE));
    await evaluateErrorRules(context, reader(), later(3 * MINUTE));
    expect(await sent()).toEqual([]);
  });
});

describe("error spike", () => {
  test("fires when the window's count reaches the threshold, in its environment, and resolves after a window below", async () => {
    const ruleId = await insertRule("error_spike", {
      environment: "production",
      fingerprint: null,
      windowMinutes: 5,
      threshold: 3,
    });
    // Old errors, outside the window, and staging's: neither counts.
    await arrive(CART, later(-10 * MINUTE), later(-10 * MINUTE));
    await arrive(CART, later(-9 * MINUTE), later(-9 * MINUTE));
    for (const minute of [1, 2, 3]) {
      await arrive(PAYMENT, later(minute * MINUTE), later(minute * MINUTE), {
        environment: "staging",
      });
    }
    await arrive(CART, later(MINUTE), later(MINUTE));
    await arrive(PAYMENT, later(2 * MINUTE), later(2 * MINUTE));
    await evaluateErrorRules(context, reader(), later(3 * MINUTE));
    expect(await sent()).toEqual([]);

    await arrive(CART, later(3 * MINUTE), later(3 * MINUTE));
    await evaluateErrorRules(context, reader(), later(4 * MINUTE));
    await evaluateErrorRules(context, reader(), later(5 * MINUTE));
    let notifications = await sent();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "error.spike",
      subject: {
        type: "errors",
        fingerprint: null,
        environment: "production",
        count: 3,
        threshold: 3,
        windowMinutes: 5,
      },
      message:
        "Shop: 3 errors in production in the last 5 minutes, at or above the rule's threshold of 3.",
      url: `${PUBLIC}/projects/${projectId}/errors?env=%22production%22`,
    });

    // Below from minute 7 (the first error leaves the window): it must stay below 5 minutes.
    await evaluateErrorRules(context, reader(), later(7 * MINUTE));
    await evaluateErrorRules(context, reader(), later(11 * MINUTE));
    expect(await sent()).toHaveLength(1);
    await evaluateErrorRules(context, reader(), later(12 * MINUTE));
    notifications = await sent();
    expect(notifications.map((payload) => payload.type)).toEqual([
      "error.spike",
      "error.spike_resolved",
    ]);
    expect(notifications[1]?.message).toBe(
      "Shop: errors in production stayed below the threshold of 3 for 5 minutes: 0 in the last 5 minutes.",
    );
    const [entry] = await historyOf(ruleId);
    expect(entry?.resolved_at).toEqual(later(12 * MINUTE));
  });

  test("a rise back above before the window ends keeps it firing", async () => {
    await insertRule("error_spike", {
      environment: null,
      fingerprint: null,
      windowMinutes: 5,
      threshold: 2,
    });
    await arrive(CART, later(MINUTE), later(MINUTE));
    await arrive(CART, later(2 * MINUTE), later(2 * MINUTE));
    await evaluateErrorRules(context, reader(), later(3 * MINUTE));
    // Below at minute 7, back above at minute 8, below again at 14.
    await evaluateErrorRules(context, reader(), later(7 * MINUTE));
    await arrive(PAYMENT, later(8 * MINUTE), later(8 * MINUTE), { environment: "staging" });
    await arrive(PAYMENT, later(8 * MINUTE), later(8 * MINUTE), { environment: "staging" });
    await evaluateErrorRules(context, reader(), later(9 * MINUTE));
    await evaluateErrorRules(context, reader(), later(14 * MINUTE));
    await evaluateErrorRules(context, reader(), later(15 * MINUTE));
    expect((await sent()).map((payload) => payload.type)).toEqual(["error.spike"]);
    await evaluateErrorRules(context, reader(), later(19 * MINUTE));
    expect((await sent()).map((payload) => payload.type)).toEqual([
      "error.spike",
      "error.spike_resolved",
    ]);
  });

  test("one group: only its occurrences count", async () => {
    await insertRule("error_spike", {
      environment: null,
      fingerprint: fingerprint(CART),
      windowMinutes: 10,
      threshold: 2,
    });
    await arrive(PAYMENT, later(MINUTE), later(MINUTE));
    await arrive(PAYMENT, later(MINUTE), later(MINUTE));
    await arrive(CART, later(2 * MINUTE), later(2 * MINUTE));
    await evaluateErrorRules(context, reader(), later(3 * MINUTE));
    expect(await sent()).toEqual([]);
    await arrive(CART, later(3 * MINUTE), later(3 * MINUTE), { environment: "staging" });
    await evaluateErrorRules(context, reader(), later(4 * MINUTE));
    const [notification] = await sent();
    expect(notification?.message).toBe(
      `Shop: 2 occurrences of TypeError: ${CART.message} in the last 10 minutes, at or above the rule's threshold of 2.`,
    );
    // No environment of its own: the group's page in its latest occurrence's.
    expect(notification?.url).toBe(
      `${PUBLIC}/projects/${projectId}/errors/${fingerprint(CART)}?env=%22staging%22`,
    );
  });
});

describe("a rule's hourly cap", () => {
  test(`sends ${RULE_HOURLY_CAP} an hour, holds back the rest in the history, then says how many`, async () => {
    const ruleId = await insertRule("error_new", { environment: null }, NOW);
    for (let index = 0; index < RULE_HOURLY_CAP + 5; index += 1) {
      await arrive(
        { type: "Error", message: `Failure number ${index}` },
        later(MINUTE),
        later(MINUTE),
      );
    }
    await evaluateErrorRules(context, reader(), later(2 * MINUTE));
    expect(await sent()).toHaveLength(RULE_HOURLY_CAP);
    const history = await historyOf(ruleId);
    expect(history).toHaveLength(RULE_HOURLY_CAP + 5);
    expect(history.filter((entry) => entry.notification_id === null)).toHaveLength(5);

    // Not before the hour is over.
    expect(await flushHeldBack(context, later(30 * MINUTE))).toBe(0);
    expect(await flushHeldBack(context, later(63 * MINUTE))).toBe(1);
    expect(await flushHeldBack(context, later(64 * MINUTE))).toBe(0);
    const notifications = await sent();
    expect(notifications).toHaveLength(RULE_HOURLY_CAP + 1);
    expect(notifications.at(-1)).toMatchObject({
      type: "alert.held_back",
      subject: { type: "rule", id: ruleId, name: "Rule error_new", held: 5, cap: RULE_HOURLY_CAP },
      message: `Shop: the alert rule "Rule error_new" held back 5 more notifications after sending ${RULE_HOURLY_CAP} in an hour, which is its limit. The rule's alert history in the dashboard lists every alert.`,
      url: `${PUBLIC}/projects/${projectId}/alerts`,
    });

    // The next hour starts afresh.
    await arrive({ type: "Error", message: "A new hour" }, later(65 * MINUTE), later(65 * MINUTE));
    await evaluateErrorRules(context, reader(), later(66 * MINUTE));
    expect((await sent()).at(-1)?.type).toBe("error.new");
  });
});

describe("evaluation after missed minutes", () => {
  test("starts where it ended, but reads at most an hour: no flood", async () => {
    await insertRule("error_new", { environment: null }, later(-4 * HOUR));
    await testDb.db
      .insertInto("alert_evaluations")
      .values({ project_id: projectId, errors_until: later(-3 * HOUR) })
      .execute();
    await arrive(CART, later(-2 * HOUR), later(-2 * HOUR));
    await arrive(PAYMENT, later(-10 * MINUTE), later(-10 * MINUTE));
    const [pass] = await evaluateErrorRules(context, reader(), NOW);
    const until = new Date(NOW.getTime() - ARRIVAL_LAG_MS);
    expect(pass?.from).toEqual(new Date(until.getTime() - MAX_CATCH_UP_MS));
    expect((await sent()).map((payload) => payload.subject.errorType)).toEqual(["Error"]);
    const cursor = await testDb.db
      .selectFrom("alert_evaluations")
      .select("errors_until")
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow();
    expect(cursor.errors_until).toEqual(until);

    // The next minute reads only that minute.
    const [next] = await evaluateErrorRules(context, reader(), later(MINUTE));
    expect(next?.from).toEqual(until);
  });

  test("an error arriving late, but within the lag, is read the next minute", async () => {
    await insertRule("error_new", { environment: null }, later(-HOUR));
    await evaluateErrorRules(context, reader(), NOW);
    // Received 10 seconds before the evaluation: inside the lag, so next time.
    await arrive(CART, later(-10_000), later(-10_000));
    await evaluateErrorRules(context, reader(), later(1000));
    expect(await sent()).toEqual([]);
    await evaluateErrorRules(context, reader(), later(MINUTE));
    expect(await sent()).toHaveLength(1);
  });
});

describe("checks deleted or recovered while an evaluation runs", () => {
  test("leave no alert firing for a check that is gone or no longer down", async () => {
    await insertRule("check_down", { checkId: null });
    for (let round = 0; round < 8; round += 1) {
      const checks = await Promise.all(
        [0, 1, 2, 3].map((index) =>
          insertCheck({
            name: `Check ${round}-${index}`,
            url: `https://check-${round}-${index}.example/`,
            state: "down",
          }),
        ),
      );
      const at = later(round * MINUTE);
      // The minute's sweep, while two checks are deleted and two come back
      // up (each with the hook the worker runs after recordOutcome).
      await Promise.all([
        evaluateCheckDown(context, {}, at),
        ...checks.slice(0, 2).map((check) => deleteCheck(testDb.db, projectId, check.id, at)),
        ...checks.slice(2).map(async (check) => {
          await recordOutcome(testDb.db, check.id, UP, at);
          await evaluateCheckDown(context, { checkId: check.id }, at);
        }),
      ]);
    }
    const { rows } = await sql<{ count: string }>`
      select count(*) from alert_states s
      where s.firing and not exists (
        select 1 from uptime_checks c where c.id::text = s.subject and c.state = 'down'
      )
    `.execute(testDb.db);
    expect(Number(rows[0]?.count)).toBe(0);
  });

  test("an alert left firing for a check that no longer exists ends, without a notification", async () => {
    const ruleId = await insertRule("check_down", { checkId: null });
    const gone = randomUUID();
    const history = await testDb.db
      .insertInto("alert_history")
      .values({
        rule_id: ruleId,
        project_id: projectId,
        kind: "check_down",
        subject: gone,
        subject_name: "Gone",
        fired_at: NOW,
        message: "Shop: the check is down.",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await testDb.db
      .insertInto("alert_states")
      .values({ rule_id: ruleId, subject: gone, firing: true, since: NOW, history_id: history.id })
      .execute();
    expect(await endOrphanedCheckAlerts(testDb.db, later(MINUTE))).toBe(1);
    expect(await testDb.db.selectFrom("alert_states").selectAll().execute()).toEqual([]);
    const [entry] = await historyOf(ruleId);
    expect(entry?.resolved_at).toEqual(later(MINUTE));
    expect(await sent()).toEqual([]);
  });
});

/**
 * Runs `evaluate` while the rule's row is locked, as a save holds it,
 * then changes the rule to `values` in the locking transaction and
 * commits: the evaluation read the rule as it was, and fires after.
 */
async function changedDuring<T>(
  ruleId: string,
  evaluate: () => Promise<T>,
  values: { kind?: RuleKind; settings: object },
): Promise<T> {
  let pending: Promise<T> | undefined;
  await testDb.db.transaction().execute(async (trx) => {
    await trx.selectFrom("alert_rules").select("id").where("id", "=", ruleId).forUpdate().execute();
    pending = evaluate();
    // Long enough for the evaluation to read the rule and reach the lock.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await trx
      .updateTable("alert_rules")
      .set({ ...values, settings: JSON.stringify(values.settings), updated_at: later(1) })
      .where("id", "=", ruleId)
      .execute();
  });
  if (pending === undefined) throw new Error("The evaluation did not start");
  return pending;
}

const firingStates = (ruleId: string) =>
  testDb.db
    .selectFrom("alert_states")
    .select("subject")
    .where("rule_id", "=", ruleId)
    .where("firing", "=", true)
    .execute();

describe("a rule changed while an evaluation runs", () => {
  test("a check rule moved to another check leaves no alert firing for the first", async () => {
    const first = await insertCheck({
      name: "First",
      url: "https://first.example/",
      state: "down",
    });
    const second = await insertCheck({
      name: "Second",
      url: "https://second.example/",
      state: "down",
    });
    const ruleId = await insertRule("check_down", { checkId: first.id });
    const counts = await changedDuring(ruleId, () => evaluateCheckDown(context, {}, NOW), {
      settings: { checkId: second.id },
    });
    expect(counts).toEqual({ sent: 0, held: 0, skipped: 1 });
    expect(await firingStates(ruleId)).toEqual([]);
    expect(await sent()).toEqual([]);

    // The next evaluation fires for the check the rule watches now, as a check alert.
    await evaluateCheckDown(context, {}, later(MINUTE));
    expect(await firingStates(ruleId)).toEqual([{ subject: second.id }]);
    expect((await historyOf(ruleId)).map((entry) => entry.kind)).toEqual(["check_down"]);
  });

  test("a spike rule changed into a check rule leaves no spike firing", async () => {
    const ruleId = await insertRule("error_spike", {
      environment: null,
      fingerprint: null,
      windowMinutes: 5,
      threshold: 1,
    });
    await arrive(CART, later(MINUTE), later(MINUTE));
    await changedDuring(ruleId, () => evaluateErrorRules(context, reader(), later(2 * MINUTE)), {
      kind: "check_down",
      settings: { checkId: null },
    });
    expect(await firingStates(ruleId)).toEqual([]);
    expect(await historyOf(ruleId)).toEqual([]);
    expect(await sent()).toEqual([]);
  });
});

describe("a regressed-error rule's guard", () => {
  test("lasts as long as the resolution, past the history's 90 days, and goes with it", async () => {
    await insertRule("error_regressed", {}, later(-2 * HOUR));
    const userId = (
      await testDb.db
        .insertInto("dashboard_users")
        .values({ name: "Cy", email: `${randomUUID()}@example.com` })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const resolve = () =>
      setResolution(testDb.db, {
        projectId,
        fingerprint: fingerprint(CART),
        resolved: true,
        userId,
      });
    await resolve();
    const again = new Date(Date.now() + MINUTE);
    await arrive(CART, again, again);
    await evaluateErrorRules(context, reader(), new Date(again.getTime() + MINUTE));
    expect(await sent()).toHaveLength(1);

    // A hundred days on, after the history was pruned, the group happens again.
    const DAY = 24 * HOUR;
    const later100 = new Date(again.getTime() + 100 * DAY);
    await pruneHistory(testDb.db, later100);
    await arrive(CART, later100, later100);
    await evaluateErrorRules(context, reader(), new Date(later100.getTime() + MINUTE));
    expect(await sent()).toHaveLength(1);

    // Resolved again: the guard goes, and the next regression is told.
    await resolve();
    const states = await testDb.db.selectFrom("alert_states").selectAll().execute();
    expect(states).toEqual([]);
    await testDb.db
      .updateTable("error_resolutions")
      .set({ resolved_at: new Date(later100.getTime() + 2 * MINUTE) })
      .where("project_id", "=", projectId)
      .execute();
    const third = new Date(later100.getTime() + 3 * MINUTE);
    await arrive(CART, third, third);
    await evaluateErrorRules(context, reader(), new Date(third.getTime() + MINUTE));
    expect((await sent()).map((payload) => payload.type)).toEqual([
      "error.regressed",
      "error.regressed",
    ]);
  });
});

describe("a rule reads nothing from before it was on", () => {
  test("a regressed-error rule added later does not tell of a regression before it", async () => {
    await insertRule("error_new", { environment: null }, later(-HOUR));
    await evaluateErrorRules(context, reader(), later(5 * MINUTE));
    const userId = (
      await testDb.db
        .insertInto("dashboard_users")
        .values({ name: "Di", email: `${randomUUID()}@example.com` })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await arrive(PAYMENT, later(-HOUR), later(-HOUR));
    await setResolution(testDb.db, {
      projectId,
      fingerprint: fingerprint(PAYMENT),
      resolved: true,
      userId,
    });
    await testDb.db
      .updateTable("error_resolutions")
      .set({ resolved_at: later(6 * MINUTE) })
      .where("project_id", "=", projectId)
      .execute();
    // It regresses at +10 minutes; the regressed rule comes at +40, and the
    // worker, away meanwhile, reads from +5 minutes at +41.
    await arrive(PAYMENT, later(10 * MINUTE), later(10 * MINUTE));
    await insertRule("error_regressed", {}, later(40 * MINUTE));
    const [pass] = await evaluateErrorRules(context, reader(), later(41 * MINUTE));
    expect(pass?.from.getTime()).toBeLessThan(later(10 * MINUTE).getTime());
    expect(await sent()).toEqual([]);
  });

  test("a new-error rule turned on again does not tell of a group that came while it was off", async () => {
    const ruleId = await insertRule("error_new", { environment: null }, later(-HOUR));
    await evaluateErrorRules(context, reader(), later(MINUTE));
    const toggle = async (enabled: boolean, at: Date) => {
      const rule = await findRule(testDb.db, projectId, ruleId);
      if (rule === null) throw new Error("no rule");
      await updateRule(testDb.db, projectId, ruleId, { ...valuesOfRule(rule), enabled }, at);
    };
    await toggle(false, later(2 * MINUTE));
    await arrive(CART, later(3 * MINUTE), later(3 * MINUTE));
    await evaluateErrorRules(context, reader(), later(4 * MINUTE));
    await toggle(true, later(5 * MINUTE));
    await arrive(PAYMENT, later(6 * MINUTE), later(6 * MINUTE));
    await evaluateErrorRules(context, reader(), later(7 * MINUTE));
    expect((await sent()).map((payload) => payload.subject.errorType)).toEqual(["Error"]);
  });
});

describe("more groups than one evaluation reads", () => {
  test("are read on the next minute, from the last group read, ties included", async () => {
    const ruleId = await insertRule("error_new", { environment: null }, NOW);
    // Ten groups in one batch: one arrival time for all.
    await storeEvents(
      testClickHouse.client,
      projectId,
      Array.from({ length: 10 }, (_, index) => {
        const error = { type: "Error", message: `Batch failure ${index}` };
        return {
          eventId: randomUUID(),
          name: "error",
          occurredAt: later(MINUTE),
          error: { ...error, handled: false, fingerprint: fingerprint(error) },
        };
      }),
      { receivedAt: later(MINUTE) },
    );
    const limits = { pageSize: 3, maxPages: 2 };
    const [first] = await evaluateErrorRules(context, reader(), later(2 * MINUTE), limits);
    expect(first).toMatchObject({ pages: 2, deferred: true });
    expect(await historyOf(ruleId)).toHaveLength(6);
    const [second] = await evaluateErrorRules(context, reader(), later(3 * MINUTE), limits);
    expect(second).toMatchObject({ pages: 2, deferred: false, from: NOW });
    const history = await historyOf(ruleId);
    expect(history).toHaveLength(10);
    expect(new Set(history.map((entry) => entry.subject)).size).toBe(10);
    const [third] = await evaluateErrorRules(context, reader(), later(4 * MINUTE), limits);
    expect(third?.from).toEqual(new Date(later(3 * MINUTE).getTime() - ARRIVAL_LAG_MS));
  });
});
