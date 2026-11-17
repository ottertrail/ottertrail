import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { copyEventsToClickHouse } from "../src/clickhouse/copy-events.ts";
import { type NewEvent, storeEvents } from "../src/collection/event-store.ts";
import { loadConfig } from "../src/config.ts";
import { insertProject } from "./helpers/projects.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

let testDb: TestDatabase | undefined;
let testClickHouse: TestClickHouse | undefined;

function db() {
  if (testDb === undefined) throw new Error("The test database was not created");
  return testDb.db;
}

function clickhouse() {
  if (testClickHouse === undefined) throw new Error("The test ClickHouse was not created");
  return testClickHouse.client;
}

beforeAll(async () => {
  [testDb, testClickHouse] = await Promise.all([createTestDatabase(), createTestClickHouse()]);
});

afterAll(async () => {
  await testDb?.destroy();
  await testClickHouse?.destroy();
});

beforeEach(async () => {
  await db().deleteFrom("events").execute();
  await clickhouse().command({ query: "TRUNCATE TABLE events" });
});

function pageview(at: string, overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date(at),
    path: "/pricing",
    visitorId: "-4611686018427387904",
    ...overrides,
  };
}

/** The events in ClickHouse, as rows, oldest first. `final` merges duplicates first. */
async function inClickHouse({ final = false } = {}) {
  const result = await clickhouse().query({
    query: `SELECT * FROM events ${final ? "FINAL" : ""} ORDER BY occurred_at, event_id`,
    format: "JSONEachRow",
  });
  return result.json<Record<string, unknown>>();
}

async function notCopied() {
  const rows = await db()
    .selectFrom("events")
    .select("event_id")
    .where("copied_at", "is", null)
    .execute();
  return rows.length;
}

describe("copying events to ClickHouse", () => {
  test("copies every column, and marks the events copied", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Copy test" });
    const event = pageview("2026-11-16T12:00:00.123Z", {
      referrer: "https://news.ycombinator.com/",
      utm: {
        source: "newsletter",
        medium: "email",
        campaign: "launch",
        term: "otters",
        content: "a",
      },
      properties: { plan: "free", seats: 3 },
      client: { browser: "Firefox", browserVersion: "142", os: "Linux", deviceType: "desktop" },
      location: { country: "DE", region: "Bavaria", city: "Munich" },
    });
    await storeEvents(db(), projectId, [event]);

    expect(await copyEventsToClickHouse(db(), clickhouse())).toBe(1);

    expect(await inClickHouse()).toEqual([
      {
        project_id: projectId,
        event_id: event.eventId,
        name: "pageview",
        occurred_at: "2026-11-16 12:00:00.123",
        received_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/),
        path: "/pricing",
        referrer: "https://news.ycombinator.com/",
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "launch",
        utm_term: "otters",
        utm_content: "a",
        properties: '{"plan":"free","seats":3}',
        browser: "Firefox",
        browser_version: "142",
        os: "Linux",
        device_type: "desktop",
        country: "DE",
        region: "Bavaria",
        city: "Munich",
        visitor_id: "-4611686018427387904",
      },
    ]);
    expect(await notCopied()).toBe(0);
    // Nothing left to copy.
    expect(await copyEventsToClickHouse(db(), clickhouse())).toBe(0);
  });

  test("copies in batches until everything is there, then only what arrives later", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Batches" });
    await storeEvents(
      db(),
      projectId,
      Array.from({ length: 5 }, (_, i) => pageview(`2026-11-16T12:00:0${i}Z`)),
    );

    expect(await copyEventsToClickHouse(db(), clickhouse(), { batchSize: 2 })).toBe(5);
    expect(await inClickHouse()).toHaveLength(5);

    await storeEvents(db(), projectId, [pageview("2026-11-16T12:01:00Z")]);
    expect(await copyEventsToClickHouse(db(), clickhouse(), { batchSize: 2 })).toBe(1);
    expect(await inClickHouse()).toHaveLength(6);
  });

  test("a batch sent again after a crash, before it was marked, is stored once", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Crash" });
    await storeEvents(db(), projectId, [
      pageview("2026-11-16T12:00:00Z"),
      pageview("2026-11-16T12:00:01Z"),
    ]);
    await copyEventsToClickHouse(db(), clickhouse());
    // As if the worker stopped after ClickHouse stored the batch, before
    // PostgreSQL recorded that it did.
    await db().updateTable("events").set({ copied_at: null }).execute();

    expect(await copyEventsToClickHouse(db(), clickhouse())).toBe(2);

    // Not even before ClickHouse merges: the insert itself was dropped.
    expect(await inClickHouse()).toHaveLength(2);
  });

  test("two workers at once copy each event once", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Two workers" });
    await storeEvents(
      db(),
      projectId,
      Array.from({ length: 40 }, (_, i) =>
        pageview(new Date(Date.UTC(2026, 10, 16, 12, 0, i)).toISOString()),
      ),
    );

    const [first, second] = await Promise.all([
      copyEventsToClickHouse(db(), clickhouse(), { batchSize: 3 }),
      copyEventsToClickHouse(db(), clickhouse(), { batchSize: 3 }),
    ]);

    expect(first + second).toBe(40);
    expect(await inClickHouse()).toHaveLength(40);
  });

  test("while ClickHouse is unreachable, events wait in PostgreSQL", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Outage" });
    await storeEvents(db(), projectId, [pageview("2026-11-16T12:00:00Z")]);
    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: testClickHouse?.database ?? "default" },
    );
    try {
      await expect(copyEventsToClickHouse(db(), unreachable)).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      await unreachable.close();
    }
    expect(await notCopied()).toBe(1);

    // Once it is back, the next run copies them.
    expect(await copyEventsToClickHouse(db(), clickhouse())).toBe(1);
    expect(await notCopied()).toBe(0);
  });
});
