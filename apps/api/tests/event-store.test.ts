import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { type NewEvent, storeEvents } from "../src/collection/event-store.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

let testDb: TestDatabase | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.destroy();
});

function db() {
  if (testDb === undefined) {
    throw new Error("The test database was not created");
  }
  return testDb.db;
}

async function createProject(name = "Test site"): Promise<string> {
  const project = await db()
    .insertInto("projects")
    .values({ name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return project.id;
}

function pageview(overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date("2026-11-16T09:14:03.000Z"),
    path: "/lessons/closures",
    ...overrides,
  };
}

async function countEvents(projectId: string): Promise<number> {
  const row = await db()
    .selectFrom("events")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("project_id", "=", projectId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe("storeEvents", () => {
  test("stores an event with both timestamps", async () => {
    const projectId = await createProject();
    const event = pageview({
      referrer: "https://news.ycombinator.com/",
      utm: { source: "newsletter", campaign: "launch" },
      properties: { plan: "free" },
    });

    await expect(storeEvents(db(), projectId, [event])).resolves.toEqual({
      inserted: 1,
      duplicates: 0,
    });

    const stored = await db()
      .selectFrom("events")
      .selectAll()
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      event_id: event.eventId,
      name: "pageview",
      path: "/lessons/closures",
      referrer: "https://news.ycombinator.com/",
      utm_source: "newsletter",
      utm_medium: null,
      utm_campaign: "launch",
      properties: { plan: "free" },
      occurred_at: event.occurredAt,
    });
    // received_at comes from the database clock, not the sender.
    expect(stored.received_at).toBeInstanceOf(Date);
    expect(Math.abs(stored.received_at.getTime() - Date.now())).toBeLessThan(60_000);
  });

  test("stores a retried event only once", async () => {
    const projectId = await createProject();
    const event = pageview();

    await storeEvents(db(), projectId, [event]);
    // The sender never heard back, so it sends the same event again.
    await expect(storeEvents(db(), projectId, [event])).resolves.toEqual({
      inserted: 0,
      duplicates: 1,
    });

    expect(await countEvents(projectId)).toBe(1);
  });

  test("stores a repeated event only once within one batch", async () => {
    const projectId = await createProject();
    const event = pageview();

    await expect(storeEvents(db(), projectId, [event, event, pageview()])).resolves.toEqual({
      inserted: 2,
      duplicates: 1,
    });
    expect(await countEvents(projectId)).toBe(2);
  });

  test("keeps projects apart: the same event ID can exist in two projects", async () => {
    const first = await createProject("First");
    const second = await createProject("Second");
    const event = pageview();

    await storeEvents(db(), first, [event]);
    await storeEvents(db(), second, [event]);

    expect(await countEvents(first)).toBe(1);
    expect(await countEvents(second)).toBe(1);
  });

  test("rejects events for a project that does not exist", async () => {
    await expect(storeEvents(db(), randomUUID(), [pageview()])).rejects.toThrow(/foreign key/);
  });

  test("saves all of a batch or none of it", async () => {
    const projectId = await createProject();
    const tooLongPath = `/${"a".repeat(2048)}`;

    await expect(
      storeEvents(db(), projectId, [pageview(), pageview({ path: tooLongPath })]),
    ).rejects.toThrow(/check constraint/);

    expect(await countEvents(projectId)).toBe(0);
  });

  test("does nothing for an empty batch", async () => {
    const projectId = await createProject();
    await expect(storeEvents(db(), projectId, [])).resolves.toEqual({
      inserted: 0,
      duplicates: 0,
    });
  });
});
