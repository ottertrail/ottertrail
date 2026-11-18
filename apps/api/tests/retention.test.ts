import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { removeDeletedRows } from "../src/clickhouse/delete-events.ts";
import { fromClickHouseTime } from "../src/clickhouse/query.ts";
import { storeEvents } from "../src/collection/event-store.ts";
import { deleteExpiredEvents } from "../src/retention/retention.ts";
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
  // One after the other: if the second fails, afterAll still drops the first.
  testDb = await createTestDatabase();
  testClickHouse = await createTestClickHouse();
});

afterAll(async () => {
  await testDb?.destroy();
  await testClickHouse?.destroy();
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

/** Events stored as collection does. */
async function events(projectId: string, times: string[]) {
  await storeEvents(
    clickhouse(),
    projectId,
    times.map((iso) => ({
      eventId: randomUUID(),
      name: "pageview",
      occurredAt: new Date(iso),
      path: "/",
    })),
  );
}

/**
 * The project's events left in ClickHouse, as reports see them, or, with
 * `onDisk`, every row still stored, deleted rows included.
 */
async function remainingInClickHouse(
  projectId: string,
  { onDisk = false } = {},
): Promise<string[]> {
  const result = await clickhouse().query({
    query: `SELECT toString(occurred_at) AS at FROM events
            WHERE project_id = {project:UUID} ORDER BY occurred_at`,
    query_params: { project: projectId },
    format: "JSONEachRow",
    clickhouse_settings: onDisk ? { apply_deleted_mask: 0 } : {},
  });
  const rows = await result.json<{ at: string }>();
  return rows.map((row) => fromClickHouseTime(row.at).toISOString());
}

// Noon on 17 November in Singapore. With 30 days kept, the cut-off is
// midnight starting 18 October there: 16:00 UTC on 17 October.
const NOW = new Date("2026-11-17T04:00:00Z");
const TIME_ZONE = "Asia/Singapore";

// ClickHouse carries out a DELETE in the background, which takes seconds.
describe("deleteExpiredEvents", { timeout: 60_000 }, () => {
  test("deletes events from before the midnight that many days ago, in the organization's timezone", async () => {
    const id = await project(30);
    await events(id, ["2026-10-17T15:59:59Z", "2026-10-17T16:00:00Z", "2026-11-17T03:00:00Z"]);

    const results = await deleteExpiredEvents(db(), clickhouse(), { now: NOW });

    expect(results.find((result) => result.projectId === id)).toEqual({
      projectId: id,
      before: new Date("2026-10-17T16:00:00Z"),
      deleted: 1,
    });
    // The whole day of 18 October stays: no report shows half a day.
    const kept = ["2026-10-17T16:00:00.000Z", "2026-11-17T03:00:00.000Z"];
    expect(await remainingInClickHouse(id)).toEqual(kept);
  });

  test("keeps everything for a project without a retention, and touches no other project", async () => {
    const forever = await project(null);
    const short = await project(30);
    await events(forever, ["2020-01-01T00:00:00Z"]);
    await events(short, ["2020-01-01T00:00:00Z"]);

    const results = await deleteExpiredEvents(db(), clickhouse(), { now: NOW });

    expect(results.map((result) => result.projectId)).not.toContain(forever);
    expect(await remainingInClickHouse(forever)).toEqual(["2020-01-01T00:00:00.000Z"]);
    expect(await remainingInClickHouse(short)).toEqual([]);
  });

  test("deletes every old event of a project at once", async () => {
    const id = await project(30);
    await events(id, [
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "2026-01-03T00:00:00Z",
      "2026-01-04T00:00:00Z",
      "2026-01-05T00:00:00Z",
      "2026-11-17T00:00:00Z",
    ]);

    const results = await deleteExpiredEvents(db(), clickhouse(), { now: NOW });

    expect(results.find((result) => result.projectId === id)).toMatchObject({
      deleted: 5,
    });
    expect(await remainingInClickHouse(id)).toEqual(["2026-11-17T00:00:00.000Z"]);
  });

  test("running it again deletes nothing more", async () => {
    const id = await project(30);
    await events(id, ["2026-01-01T00:00:00Z", "2026-11-17T00:00:00Z"]);
    await deleteExpiredEvents(db(), clickhouse(), { now: NOW });

    const again = await deleteExpiredEvents(db(), clickhouse(), { now: NOW });

    expect(again.find((result) => result.projectId === id)).toMatchObject({
      deleted: 0,
    });
  });

  test("each project's cut-off is midnight in its own organization's timezone", async () => {
    const singapore = await project(30, "Asia/Singapore");
    const utc = await project(30, "UTC");

    const results = await deleteExpiredEvents(db(), clickhouse(), { now: NOW });

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

    const results = await deleteExpiredEvents(db(), clickhouse(), { now: NOW });

    expect(results.map((result) => result.projectId)).not.toContain(lost);
    expect(await remainingInClickHouse(lost)).toEqual(["2020-01-01T00:00:00.000Z"]);
    expect(await remainingInClickHouse(fine)).toEqual([]);
  });

  test("each project's own cut-off applies in the same run", async () => {
    const singapore = await project(30, "Asia/Singapore");
    const utc = await project(30, "UTC");
    // After Singapore's cut-off (16:00 UTC on 17 October), before UTC's (midnight on the 18th).
    await events(singapore, ["2026-10-17T20:00:00Z"]);
    await events(utc, ["2026-10-17T20:00:00Z"]);

    await deleteExpiredEvents(db(), clickhouse(), { now: NOW });

    expect(await remainingInClickHouse(singapore)).toEqual(["2026-10-17T20:00:00.000Z"]);
    expect(await remainingInClickHouse(utc)).toEqual([]);
  });

  test("deleted rows leave ClickHouse's disk afterwards, even those an earlier run left", async () => {
    const id = await project(30);
    await events(id, ["2026-01-01T00:00:00Z", "2026-11-17T00:00:00Z"]);
    // Deleted, but not yet off the disk: as if the run had stopped here.
    await deleteExpiredEvents(db(), clickhouse(), { now: NOW });
    expect(await remainingInClickHouse(id, { onDisk: true })).toHaveLength(2);

    // The next run has nothing new to delete, and still clears the disk.
    expect(await removeDeletedRows(clickhouse(), { wait: true })).toEqual({ started: true });

    expect(await remainingInClickHouse(id, { onDisk: true })).toEqual(["2026-11-17T00:00:00.000Z"]);
    // Nothing left to rewrite.
    expect(await removeDeletedRows(clickhouse())).toEqual({ started: false });
  });

  test("the database refuses a retention under 30 days or over 10 years", async () => {
    await expect(project(29)).rejects.toThrow(/check/);
    await expect(project(3651)).rejects.toThrow(/check/);
  });
});
