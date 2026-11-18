import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  CHANNEL_HOURLY_CAP,
  LAST_ATTEMPT_LEASE_SECONDS,
  MAX_ATTEMPTS,
  notify,
  type NotifyInput,
  pruneDeliveries,
  recordAttempt,
  RETRY_DELAYS_SECONDS,
  sendTest,
  takeDueDeliveries,
} from "../src/notifications/deliveries.ts";
import { DeliverySender } from "../src/notifications/sender.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";
import { testLookup } from "./helpers/uptime-servers.ts";
import { startWebhookReceiver, type WebhookReceiver } from "./helpers/webhook-receiver.ts";

let testDb: TestDatabase;
let receiver: WebhookReceiver;
let hook = "";
let other = "";

const SECRET = "s".repeat(43);

beforeAll(async () => {
  testDb = await createTestDatabase();
  receiver = await startWebhookReceiver();
});

afterAll(async () => {
  await receiver?.close();
  await testDb?.destroy();
});

async function insertWebhook(name: string, path = "/hook"): Promise<string> {
  const row = await testDb.db
    .insertInto("notification_channels")
    .values({
      name,
      kind: "webhook",
      webhook_url: `http://hooks.test:${receiver.port}${path}`,
      webhook_secret: SECRET,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(async () => {
  await testDb.db.deleteFrom("notification_channels").execute();
  receiver.requests.length = 0;
  receiver.answer.status = 200;
  hook = await insertWebhook("Hook");
  other = await insertWebhook("Other");
});

const input = (channelIds: string[], more: Partial<NotifyInput> = {}): NotifyInput => ({
  channelIds,
  type: "check.down",
  project: { id: "0d6e5f80-0c4f-4b8e-9d3a-3f8f6a1c2b7e", name: "Shop" },
  subject: { type: "check", id: "c0ffee00-0000-4000-8000-000000000001", name: "API health" },
  message: "API health is down: it answered 503.",
  url: "https://ottertrail.example.com/projects/0d6e5f80/uptime/c0ffee00",
  ...more,
});

function sender(more: { now?: () => Date; maxSending?: number } = {}) {
  return new DeliverySender({
    db: testDb.db,
    mailer: null,
    // The receiver is on loopback.
    policy: { allowPrivate: true },
    lookup: testLookup({ "hooks.test": ["127.0.0.1"] }),
    ...more,
  });
}

const rows = () =>
  testDb.db.selectFrom("notification_deliveries").selectAll().orderBy("created_at").execute();

/** The database's clock, which takeDueDeliveries reads when given no time. */
async function dbNow(): Promise<Date> {
  const {
    rows: [row],
  } = await sql<{ now: Date }>`select now() as now`.execute(testDb.db);
  if (row === undefined) throw new Error("no time");
  return row.now;
}

describe("notify", () => {
  test("records one pending delivery per channel, before anything is sent", async () => {
    const recorded = await notify(testDb.db, input([hook, other, hook]));
    expect(recorded.deliveries).toHaveLength(2);
    expect(recorded.deliveries.every((delivery) => delivery.status === "pending")).toBe(true);
    const stored = await rows();
    expect(stored.map((row) => row.channel_id).toSorted()).toEqual([hook, other].toSorted());
    for (const row of stored) {
      expect(row).toMatchObject({
        notification_id: recorded.notificationId,
        event_type: "check.down",
        status: "pending",
        attempts: 0,
        last_error: null,
        sent_at: null,
      });
      expect(row.next_attempt_at).not.toBeNull();
      expect(row.payload).toMatchObject({
        version: 1,
        id: recorded.notificationId,
        type: "check.down",
        project: { name: "Shop" },
        message: "API health is down: it answered 503.",
      });
    }
    expect(receiver.requests).toEqual([]);
  });

  test("skips channels that do not exist, and refuses what step 3 must never send", async () => {
    const recorded = await notify(testDb.db, input([hook, "00000000-0000-4000-8000-000000000000"]));
    expect(recorded.deliveries.map((delivery) => delivery.channelId)).toEqual([hook]);
    expect(await notify(testDb.db, input([]))).toMatchObject({ deliveries: [] });
    await expect(notify(testDb.db, input([hook], { message: " " }))).rejects.toThrow(
      "A notification's message has 1 to 1000 characters",
    );
    await expect(notify(testDb.db, input([hook], { url: "/relative" }))).rejects.toThrow(
      "A notification's url is an absolute http(s) URL",
    );
    await expect(
      notify(testDb.db, input([hook], { subject: { nested: {} as unknown as string } })),
    ).rejects.toThrow("A subject's values are numbers");
    await expect(
      notify(testDb.db, input([hook], { type: "nope" as unknown as "test" })),
    ).rejects.toThrow("Unknown event type");
  });

  test(`caps a channel at ${CHANNEL_HOURLY_CAP} deliveries an hour; past it they fail, saying why`, async () => {
    await testDb.db
      .insertInto("notification_deliveries")
      .values(
        Array.from({ length: CHANNEL_HOURLY_CAP }, () => ({
          notification_id: crypto.randomUUID(),
          channel_id: hook,
          event_type: "check.down",
          payload: "{}",
          status: "sent" as const,
          attempts: 1,
        })),
      )
      .execute();
    const recorded = await notify(testDb.db, input([hook, other]));
    expect(recorded.deliveries.find((d) => d.channelId === hook)?.status).toBe("failed");
    expect(recorded.deliveries.find((d) => d.channelId === other)?.status).toBe("pending");
    const capped = await testDb.db
      .selectFrom("notification_deliveries")
      .selectAll()
      .where("id", "=", recorded.deliveries.find((d) => d.channelId === hook)?.id ?? "")
      .executeTakeFirstOrThrow();
    expect(capped).toMatchObject({
      status: "failed",
      attempts: 0,
      refused: 1,
      next_attempt_at: null,
      last_error: `Not sent: this channel had ${CHANNEL_HOURLY_CAP} deliveries in the last hour, its limit.`,
    });

    // Later refusals in the hour only count on that one row.
    for (let index = 0; index < 5; index += 1) {
      const again = await notify(testDb.db, input([hook]));
      expect(again.deliveries).toEqual([{ id: capped.id, channelId: hook, status: "failed" }]);
    }
    const refusals = await testDb.db
      .selectFrom("notification_deliveries")
      .selectAll()
      .where("channel_id", "=", hook)
      .where("refused", ">", 0)
      .execute();
    expect(refusals).toMatchObject([
      {
        id: capped.id,
        refused: 6,
        last_error: `Not sent: this channel had ${CHANNEL_HOURLY_CAP} deliveries in the last hour, its limit. 6 notifications refused so far.`,
      },
    ]);

    // Refused ones do not count: once the hour has passed, the channel takes deliveries again.
    await testDb.db
      .updateTable("notification_deliveries")
      .set({ created_at: sql<Date>`now() - interval '61 minutes'` })
      .where("channel_id", "=", hook)
      .where("status", "=", "sent")
      .execute();
    const after = await notify(testDb.db, input([hook]));
    expect(after.deliveries[0]?.status).toBe("pending");
  });

  test("sends do not count towards the hourly cap; they have their own limit", async () => {
    await testDb.db
      .insertInto("notification_deliveries")
      .values(
        Array.from({ length: CHANNEL_HOURLY_CAP }, (_, index) => ({
          notification_id: crypto.randomUUID(),
          channel_id: hook,
          event_type: "test",
          payload: "{}",
          status: "sent" as const,
          attempts: 1,
          // 5 a minute for the last 12 minutes.
          created_at: new Date(Date.now() - (2 + Math.floor(index / 5)) * 60_000),
        })),
      )
      .execute();
    const recorded = await notify(testDb.db, input([hook]));
    expect(recorded.deliveries[0]?.status).toBe("pending");
    // And a capped channel still takes a test send.
    await testDb.db
      .insertInto("notification_deliveries")
      .values(
        Array.from({ length: CHANNEL_HOURLY_CAP }, () => ({
          notification_id: crypto.randomUUID(),
          channel_id: hook,
          event_type: "check.down",
          payload: "{}",
          status: "sent" as const,
          attempts: 1,
        })),
      )
      .execute();
    expect((await notify(testDb.db, input([hook]))).deliveries[0]?.status).toBe("failed");
    const testSend = await sendTest(testDb.db, hook, {
      project: null,
      subject: { type: "channel", id: hook, name: "Hook" },
      message: "A test.",
      url: "https://ottertrail.example.com/settings",
    });
    expect(testSend).toMatchObject({ deliveries: [{ status: "pending" }] });
  });
});

describe("the worker", () => {
  test("sends a due delivery and records it sent", async () => {
    const recorded = await notify(testDb.db, input([hook]));
    const worker = sender();
    expect(await worker.tick()).toBe(1);
    await worker.drain();
    const [row] = await rows();
    expect(row?.status).toBe("sent");
    expect(row).toMatchObject({ attempts: 1, next_attempt_at: null, last_error: null });
    expect(row?.sent_at).not.toBeNull();
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0]?.headers["ottertrail-delivery"]).toBe(recorded.deliveries[0]?.id);
  });

  test("two workers at once take each delivery once", async () => {
    for (let index = 0; index < 15; index += 1) await notify(testDb.db, input([hook, other]));
    const [first, second] = await Promise.all([
      takeDueDeliveries(testDb.db, { limit: 20 }),
      takeDueDeliveries(testDb.db, { limit: 20 }),
    ]);
    const ids = [...(first ?? []), ...(second ?? [])].map((delivery) => delivery.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    // Taken means its next attempt moved on: nothing is due now.
    expect(await takeDueDeliveries(testDb.db, { limit: 20 })).toEqual([]);
  });

  test("sends at most its limit at once", async () => {
    for (let index = 0; index < 8; index += 1) await notify(testDb.db, input([hook]));
    const worker = sender({ maxSending: 3 });
    expect(await worker.tick()).toBe(3);
    await worker.drain();
    expect(await worker.tick()).toBe(3);
    await worker.drain();
    expect(await worker.tick()).toBe(2);
    await worker.drain();
    expect((await rows()).every((row) => row.status === "sent")).toBe(true);
  });

  test("retries 4xx and 5xx with growing waits, then gives up after about an hour", async () => {
    receiver.answer.status = 503;
    await notify(testDb.db, input([hook]));
    let at = await dbNow();
    const waits: number[] = [];
    const seen: { status: string; attempts: number; error: string | null }[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt === 4) receiver.answer.status = 404;
      // Not before it is due.
      expect(
        await takeDueDeliveries(testDb.db, { limit: 10, now: new Date(at.getTime() - 1000) }),
      ).toEqual([]);
      const worker = sender({ now: () => at });
      expect(await worker.tick()).toBe(1);
      await worker.drain();
      const [row] = await rows();
      seen.push({
        status: row?.status ?? "",
        attempts: row?.attempts ?? 0,
        error: row?.last_error ?? null,
      });
      if (row?.next_attempt_at != null) {
        waits.push((row.next_attempt_at.getTime() - at.getTime()) / 1000);
        at = row.next_attempt_at;
      }
    }
    expect(seen).toEqual(
      Array.from({ length: MAX_ATTEMPTS }, (_, index) => ({
        status: index + 1 < MAX_ATTEMPTS ? "pending" : "failed",
        attempts: index + 1,
        error: `It answered ${index + 1 >= 4 ? 404 : 503}; a webhook must answer 2xx.`,
      })),
    );
    expect((await rows())[0]?.next_attempt_at).toBeNull();
    expect(waits).toEqual([...RETRY_DELAYS_SECONDS]);
    const total = waits.reduce((sum, wait) => sum + wait, 0);
    expect(total).toBeGreaterThan(50 * 60);
    expect(total).toBeLessThan(70 * 60);
    expect(receiver.requests).toHaveLength(MAX_ATTEMPTS);
  });

  test("a retry that succeeds is sent", async () => {
    receiver.answer.status = 500;
    await notify(testDb.db, input([hook]));
    const at = await dbNow();
    const worker = sender({ now: () => at });
    await worker.tick();
    await worker.drain();
    receiver.answer.status = 204;
    const later = new Date(at.getTime() + RETRY_DELAYS_SECONDS[0] * 1000);
    const again = sender({ now: () => later });
    expect(await again.tick()).toBe(1);
    await again.drain();
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 2, last_error: null }]);
  });

  test("a worker that stops mid-send does not lose the delivery, nor try it for ever", async () => {
    await notify(testDb.db, input([hook]));
    const at = await dbNow();
    // Taken, then the worker stops: no outcome is recorded.
    const [taken] = await takeDueDeliveries(testDb.db, { limit: 10, now: at });
    expect(taken?.attempt).toBe(1);
    expect(await takeDueDeliveries(testDb.db, { limit: 10, now: at })).toEqual([]);
    // After the first wait, it is taken again.
    const later = new Date(at.getTime() + RETRY_DELAYS_SECONDS[0] * 1000);
    const [again] = await takeDueDeliveries(testDb.db, { limit: 10, now: later });
    expect(again?.attempt).toBe(2);
    // The first attempt's late outcome is not recorded over the second's.
    expect(await recordAttempt(testDb.db, { id: taken?.id ?? "", attempt: 1 }, { ok: true })).toBe(
      null,
    );

    // A delivery whose every attempt stops the worker: after the last, it fails.
    await testDb.db
      .updateTable("notification_deliveries")
      .set({ attempts: MAX_ATTEMPTS - 1, next_attempt_at: at })
      .execute();
    const [last] = await takeDueDeliveries(testDb.db, { limit: 10, now: at });
    expect(last?.attempt).toBe(MAX_ATTEMPTS);
    const afterLease = new Date(at.getTime() + (LAST_ATTEMPT_LEASE_SECONDS + 1) * 1000);
    expect(await takeDueDeliveries(testDb.db, { limit: 10, now: afterLease })).toEqual([]);
    expect(await rows()).toMatchObject([
      {
        status: "failed",
        attempts: MAX_ATTEMPTS,
        next_attempt_at: null,
        last_error: "The last attempt did not finish: the worker stopped while sending.",
      },
    ]);
  });

  test("never takes a delivery past its last attempt, even one whose lease just ended", async () => {
    await notify(testDb.db, input([hook, other]));
    const at = await dbNow();
    const [exhausted, fresh] = await rows();
    // One delivery at its last attempt, due exactly now; the other due as usual.
    await testDb.db
      .updateTable("notification_deliveries")
      .set({ attempts: MAX_ATTEMPTS, next_attempt_at: at })
      .where("id", "=", exhausted?.id ?? "")
      .execute();
    const taken = await takeDueDeliveries(testDb.db, { limit: 10, now: at });
    expect(taken.map((delivery) => delivery.id)).toEqual([fresh?.id]);
    const after = await testDb.db
      .selectFrom("notification_deliveries")
      .selectAll()
      .where("id", "=", exhausted?.id ?? "")
      .executeTakeFirstOrThrow();
    expect(after).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      next_attempt_at: null,
    });

    // Concurrent takes at the same moment never fail as a batch.
    await testDb.db
      .updateTable("notification_deliveries")
      .set({ status: "pending", attempts: MAX_ATTEMPTS, next_attempt_at: at, last_error: null })
      .where("id", "=", exhausted?.id ?? "")
      .execute();
    await expect(
      Promise.all(
        Array.from({ length: 4 }, () => takeDueDeliveries(testDb.db, { limit: 10, now: at })),
      ),
    ).resolves.toHaveLength(4);
  });

  test("a deleted channel's deliveries go with it", async () => {
    await notify(testDb.db, input([hook, other]));
    await testDb.db.deleteFrom("notification_channels").where("id", "=", hook).execute();
    expect((await rows()).map((row) => row.channel_id)).toEqual([other]);
  });
});

describe("pruneDeliveries", () => {
  test("deletes deliveries older than 30 days, and only those", async () => {
    await notify(testDb.db, input([hook, other]));
    await notify(testDb.db, input([hook]));
    const [oldest] = await rows();
    await testDb.db
      .updateTable("notification_deliveries")
      .set({ created_at: sql<Date>`now() - interval '31 days'` })
      .where("id", "=", oldest?.id ?? "")
      .execute();
    await testDb.db
      .updateTable("notification_deliveries")
      .set({ created_at: sql<Date>`now() - interval '29 days'` })
      .where("id", "!=", oldest?.id ?? "")
      .where("channel_id", "=", other)
      .execute();
    expect(await pruneDeliveries(testDb.db)).toBe(1);
    expect(await rows()).toHaveLength(2);
    expect(await pruneDeliveries(testDb.db)).toBe(0);
  });
});
