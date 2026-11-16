import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { storeEvents } from "../src/collection/event-store.ts";
import { deleteExpiredEvents } from "../src/retention/retention.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

let testDb: TestDatabase | undefined;

function db() {
  if (testDb === undefined) throw new Error("The test database was not created");
  return testDb.db;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.destroy();
});

async function project(retentionDays: number | null) {
  const { id } = await db()
    .insertInto("projects")
    .values({ name: "Retention test", retention_days: retentionDays })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

async function events(projectId: string, times: string[]) {
  await storeEvents(
    db(),
    projectId,
    times.map((iso) => ({
      eventId: randomUUID(),
      name: "pageview",
      occurredAt: new Date(iso),
      path: "/",
    })),
  );
}

async function remaining(projectId: string): Promise<string[]> {
  const rows = await db()
    .selectFrom("events")
    .select("occurred_at")
    .where("project_id", "=", projectId)
    .orderBy("occurred_at")
    .execute();
  return rows.map((row) => row.occurred_at.toISOString());
}

// Noon on 17 November in Singapore. With 30 days kept, the cut-off is
// midnight starting 18 October there: 16:00 UTC on 17 October.
const NOW = new Date("2026-11-17T04:00:00Z");
const TIME_ZONE = "Asia/Singapore";

describe("deleteExpiredEvents", () => {
  test("deletes events from before the midnight that many days ago, in the instance's timezone", async () => {
    const id = await project(30);
    await events(id, ["2026-10-17T15:59:59Z", "2026-10-17T16:00:00Z", "2026-11-17T03:00:00Z"]);

    const results = await deleteExpiredEvents(db(), { timeZone: TIME_ZONE, now: NOW });

    expect(results.find((result) => result.projectId === id)).toEqual({
      projectId: id,
      before: new Date("2026-10-17T16:00:00Z"),
      deleted: 1,
    });
    // The whole day of 18 October stays: no report shows half a day.
    expect(await remaining(id)).toEqual(["2026-10-17T16:00:00.000Z", "2026-11-17T03:00:00.000Z"]);
  });

  test("keeps everything for a project without a retention, and touches no other project", async () => {
    const forever = await project(null);
    const short = await project(30);
    await events(forever, ["2020-01-01T00:00:00Z"]);
    await events(short, ["2020-01-01T00:00:00Z"]);

    const results = await deleteExpiredEvents(db(), { timeZone: TIME_ZONE, now: NOW });

    expect(results.map((result) => result.projectId)).not.toContain(forever);
    expect(await remaining(forever)).toEqual(["2020-01-01T00:00:00.000Z"]);
    expect(await remaining(short)).toEqual([]);
  });

  test("deletes in batches until nothing old is left", async () => {
    const id = await project(30);
    await events(id, [
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "2026-01-03T00:00:00Z",
      "2026-01-04T00:00:00Z",
      "2026-01-05T00:00:00Z",
      "2026-11-17T00:00:00Z",
    ]);

    const results = await deleteExpiredEvents(db(), {
      timeZone: TIME_ZONE,
      now: NOW,
      batchSize: 2,
    });

    expect(results.find((result) => result.projectId === id)?.deleted).toBe(5);
    expect(await remaining(id)).toEqual(["2026-11-17T00:00:00.000Z"]);
  });

  test("running it again deletes nothing more", async () => {
    const id = await project(30);
    await events(id, ["2026-01-01T00:00:00Z", "2026-11-17T00:00:00Z"]);
    await deleteExpiredEvents(db(), { timeZone: TIME_ZONE, now: NOW });

    const again = await deleteExpiredEvents(db(), { timeZone: TIME_ZONE, now: NOW });

    expect(again.find((result) => result.projectId === id)?.deleted).toBe(0);
    expect(await remaining(id)).toEqual(["2026-11-17T00:00:00.000Z"]);
  });

  test("the database refuses a retention under 30 days or over 10 years", async () => {
    await expect(project(29)).rejects.toThrow(/check/);
    await expect(project(3651)).rejects.toThrow(/check/);
  });
});
