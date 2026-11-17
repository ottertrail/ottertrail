import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import {
  COPY_BATCH_SIZE,
  copyEventsToClickHouse,
  deleteCopiedEvents,
  KEEP_IN_POSTGRES_MS,
} from "../src/clickhouse/copy-events.ts";
import { type NewEvent, storeEvents } from "../src/collection/event-store.ts";
import { loadConfig } from "../src/config.ts";
import { insertProject } from "./helpers/projects.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";
import {
  createTestDatabase,
  migrateTestDatabase,
  type TestDatabase,
} from "./helpers/test-database.ts";

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
  // One after the other: if the second fails, afterAll still drops the first.
  testDb = await createTestDatabase();
  testClickHouse = await createTestClickHouse();
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
      environment: "staging",
      release: "1.4.2",
      userId: "user-42",
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
        environment: "staging",
        release: "1.4.2",
        user_id: "user-42",
        // Only an error has these.
        error_type: "",
        error_message: "",
        error_stack: "",
        error_handled: false,
        error_fingerprint: "",
      },
    ]);
    expect(await notCopied()).toBe(0);
    // Nothing left to copy.
    expect(await copyEventsToClickHouse(db(), clickhouse())).toBe(0);
  });

  test("copies an error's details, and an error without a stack", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Errors" });
    const withStack = pageview("2026-11-16T12:00:00.000Z", {
      name: "error",
      error: {
        type: "TypeError",
        message: "x is undefined",
        stack: "TypeError: x is undefined\n    at f (https://a.example/app.js:1:2)",
        handled: false,
        fingerprint: "1-0123456789abcdef0123",
      },
    });
    const withoutStack = pageview("2026-11-16T12:00:01.000Z", {
      name: "error",
      error: {
        type: "Error",
        message: "Declined",
        handled: true,
        fingerprint: "1-abcdefabcdefabcdefab",
      },
    });
    await storeEvents(db(), projectId, [withStack, withoutStack]);
    await copyEventsToClickHouse(db(), clickhouse());

    const rows = (await inClickHouse()).filter((row) => row.project_id === projectId);
    expect(rows).toMatchObject([
      {
        name: "error",
        error_type: "TypeError",
        error_message: "x is undefined",
        error_stack: "TypeError: x is undefined\n    at f (https://a.example/app.js:1:2)",
        error_handled: false,
        error_fingerprint: "1-0123456789abcdef0123",
      },
      { error_type: "Error", error_stack: "", error_handled: true },
    ]);
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

  test("copies a full batch at once", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Full batch" });
    // More rows than one insert of storeEvents may hold, so straight in SQL.
    await sql`
      insert into events (project_id, event_id, name, occurred_at, received_at, path, visitor_id)
      select ${projectId}, gen_random_uuid(), 'pageview',
             '2026-11-16T12:00:00Z'::timestamptz + i * interval '1 millisecond', now(), '/', 1
      from generate_series(1, ${COPY_BATCH_SIZE}) as i
    `.execute(db());

    expect(await copyEventsToClickHouse(db(), clickhouse())).toBe(COPY_BATCH_SIZE);

    expect(await notCopied()).toBe(0);
    const [counted] = await (
      await clickhouse().query({ query: "SELECT count() AS n FROM events", format: "JSONEachRow" })
    ).json<{ n: string }>();
    expect(Number(counted?.n)).toBe(COPY_BATCH_SIZE);
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

async function lastEventAt(projectId: string) {
  const project = await db()
    .selectFrom("projects")
    .select("last_event_at")
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();
  return project.last_event_at;
}

describe("each project's latest event", () => {
  test("is recorded as events are copied, and a late, earlier event leaves it", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Latest" });
    const { id: otherId } = await insertProject(db(), { name: "Other" });
    expect(await lastEventAt(projectId)).toBeNull();

    await storeEvents(db(), projectId, [
      pageview("2026-11-16T12:00:00Z"),
      pageview("2026-11-16T12:05:00Z"),
    ]);
    await storeEvents(db(), otherId, [pageview("2026-11-16T09:00:00Z")]);
    await copyEventsToClickHouse(db(), clickhouse());
    expect(await lastEventAt(projectId)).toEqual(new Date("2026-11-16T12:05:00Z"));
    expect(await lastEventAt(otherId)).toEqual(new Date("2026-11-16T09:00:00Z"));

    // Sent late from a browser that was offline: it happened before the latest.
    await storeEvents(db(), projectId, [pageview("2026-11-16T11:00:00Z")]);
    await copyEventsToClickHouse(db(), clickhouse());
    expect(await lastEventAt(projectId)).toEqual(new Date("2026-11-16T12:05:00Z"));
  });

  test("migration 0012 fills it in from the events already stored", async () => {
    const own = await createTestDatabase();
    try {
      await migrateTestDatabase(own, "0011_add_events_copied_at");
      const { id: projectId } = await insertProject(own.db, { name: "Before" });
      const { id: emptyId } = await insertProject(own.db, { name: "Empty" });
      await storeEvents(own.db, projectId, [
        pageview("2026-11-16T12:00:00Z"),
        pageview("2026-11-16T08:00:00Z"),
      ]);

      await migrateTestDatabase(own, "latest");

      const rows = await own.db
        .selectFrom("projects")
        .select(["id", "last_event_at"])
        .orderBy("name")
        .execute();
      expect(rows).toEqual([
        { id: projectId, last_event_at: new Date("2026-11-16T12:00:00Z") },
        { id: emptyId, last_event_at: null },
      ]);
    } finally {
      await own.destroy();
    }
  });
});

/** A pageview at a moment given in milliseconds since 1970. */
const pageviewAt = (at: number) => pageview(new Date(at).toISOString());

describe("deleting copied events from PostgreSQL", () => {
  const NOW = new Date("2026-11-17T12:00:00Z");

  test("deletes only copied events too old for a retry to arrive", async () => {
    const { id: projectId } = await insertProject(db(), { name: "Prune" });
    const cutOff = NOW.getTime() - KEEP_IN_POSTGRES_MS;
    const old = pageviewAt(cutOff - 1);
    const recent = pageviewAt(cutOff + 1);
    await storeEvents(db(), projectId, [old, recent]);
    await copyEventsToClickHouse(db(), clickhouse());
    // Arrived but not copied yet, as when ClickHouse is down: it must wait.
    const notYetCopied = pageviewAt(cutOff - 60_000);
    await storeEvents(db(), projectId, [notYetCopied]);

    expect(await deleteCopiedEvents(db(), { now: NOW, batchSize: 1 })).toBe(1);

    const left = await db()
      .selectFrom("events")
      .select("event_id")
      .orderBy("occurred_at")
      .execute();
    expect(left.map((row) => row.event_id)).toEqual([notYetCopied.eventId, recent.eventId]);
    // ClickHouse still holds both copied events.
    expect(await inClickHouse()).toHaveLength(2);
    // A retry of the recent event still meets PostgreSQL's unique key.
    expect(await storeEvents(db(), projectId, [recent])).toEqual({ inserted: 0, duplicates: 1 });
  });

  test("works through many events in batches, project by project", async () => {
    const first = await insertProject(db(), { name: "First" });
    const second = await insertProject(db(), { name: "Second" });
    await storeEvents(
      db(),
      first.id,
      Array.from({ length: 5 }, (_, i) => pageviewAt(Date.UTC(2026, 10, 10, 12, 0, i))),
    );
    await storeEvents(
      db(),
      second.id,
      Array.from({ length: 3 }, (_, i) => pageviewAt(Date.UTC(2026, 10, 10, 12, 0, i))),
    );
    await copyEventsToClickHouse(db(), clickhouse());

    expect(await deleteCopiedEvents(db(), { now: NOW, batchSize: 2 })).toBe(8);
    expect(await db().selectFrom("events").select("event_id").execute()).toEqual([]);
    // Nothing left: a second run deletes nothing.
    expect(await deleteCopiedEvents(db(), { now: NOW })).toBe(0);
  });
});
