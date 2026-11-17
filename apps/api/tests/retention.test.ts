import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { storeEvents } from "../src/collection/event-store.ts";
import { deleteExpiredEvents } from "../src/retention/retention.ts";
import { insertProject } from "./helpers/projects.ts";
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

/** A project in an organization of its own, in `timeZone` (Singapore unless given). */
async function project(retentionDays: number | null, timeZone = TIME_ZONE) {
  const { id } = await insertProject(
    db(),
    { name: "Retention test", retention_days: retentionDays },
    { timeZone },
  );
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
  test("deletes events from before the midnight that many days ago, in the organization's timezone", async () => {
    const id = await project(30);
    await events(id, ["2026-10-17T15:59:59Z", "2026-10-17T16:00:00Z", "2026-11-17T03:00:00Z"]);

    const results = await deleteExpiredEvents(db(), { now: NOW });

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

    const results = await deleteExpiredEvents(db(), { now: NOW });

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

    const results = await deleteExpiredEvents(db(), { now: NOW, batchSize: 2 });

    expect(results.find((result) => result.projectId === id)?.deleted).toBe(5);
    expect(await remaining(id)).toEqual(["2026-11-17T00:00:00.000Z"]);
  });

  test("running it again deletes nothing more", async () => {
    const id = await project(30);
    await events(id, ["2026-01-01T00:00:00Z", "2026-11-17T00:00:00Z"]);
    await deleteExpiredEvents(db(), { now: NOW });

    const again = await deleteExpiredEvents(db(), { now: NOW });

    expect(again.find((result) => result.projectId === id)?.deleted).toBe(0);
    expect(await remaining(id)).toEqual(["2026-11-17T00:00:00.000Z"]);
  });

  test("each project's cut-off is midnight in its own organization's timezone", async () => {
    const singapore = await project(30, "Asia/Singapore");
    const utc = await project(30, "UTC");

    const results = await deleteExpiredEvents(db(), { now: NOW });

    // Midnight starting 18 October: 16:00 UTC on 17 October in Singapore,
    // 00:00 UTC on 18 October in UTC.
    expect(results.find((result) => result.projectId === singapore)?.before).toEqual(
      new Date("2026-10-17T16:00:00Z"),
    );
    expect(results.find((result) => result.projectId === utc)?.before).toEqual(
      new Date("2026-10-18T00:00:00Z"),
    );
  });

  test("an organization in a timezone PostgreSQL does not know is skipped, not everyone", async () => {
    const lost = await project(30, "Nowhere/Nothing");
    const fine = await project(30, "UTC");
    await events(lost, ["2020-01-01T00:00:00Z"]);
    await events(fine, ["2020-01-01T00:00:00Z"]);

    const results = await deleteExpiredEvents(db(), { now: NOW });

    expect(results.map((result) => result.projectId)).not.toContain(lost);
    expect(await remaining(fine)).toEqual([]);
  });

  test("the database refuses a retention under 30 days or over 10 years", async () => {
    await expect(project(29)).rejects.toThrow(/check/);
    await expect(project(3651)).rejects.toThrow(/check/);
  });
});
