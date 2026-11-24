import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { removeDeletedRows } from "../src/clickhouse/delete-events.ts";
import { TELEMETRY_TABLES } from "../src/clickhouse/migrations.ts";
import { clickHouseTime, fromClickHouseTime } from "../src/clickhouse/query.ts";
import { storeEvents } from "../src/collection/event-store.ts";
import { effectiveTelemetryRetentionDays } from "../src/projects/telemetry-retention.ts";
import { deleteExpiredEvents, deleteExpiredTelemetry } from "../src/retention/retention.ts";
import { insertProject, setInstanceTimeZone } from "./helpers/projects.ts";
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
  await setInstanceTimeZone(testDb.db, TIME_ZONE);
});

afterAll(async () => {
  await testDb?.destroy();
  await testClickHouse?.destroy();
});

/** A project that keeps its events `retentionDays` days. */
async function project(retentionDays: number | null) {
  const { id } = await insertProject(db(), {
    name: "Retention test",
    retention_days: retentionDays,
  });
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
  test("deletes events from before the midnight that many days ago, in the instance's timezone", async () => {
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

  test("the cut-off moves with the instance's timezone", async () => {
    const id = await project(30);
    // After Singapore's cut-off (16:00 UTC on 17 October), before UTC's (midnight on the 18th).
    await events(id, ["2026-10-17T20:00:00Z"]);

    const inSingapore = await deleteExpiredEvents(db(), clickhouse(), { now: NOW });
    expect(inSingapore.find((result) => result.projectId === id)).toMatchObject({
      before: new Date("2026-10-17T16:00:00Z"),
      deleted: 0,
    });
    expect(await remainingInClickHouse(id)).toEqual(["2026-10-17T20:00:00.000Z"]);

    await setInstanceTimeZone(db(), "UTC");
    try {
      const inUtc = await deleteExpiredEvents(db(), clickhouse(), { now: NOW });
      expect(inUtc.find((result) => result.projectId === id)).toMatchObject({
        before: new Date("2026-10-18T00:00:00Z"),
        deleted: 1,
      });
      expect(await remainingInClickHouse(id)).toEqual([]);
    } finally {
      await setInstanceTimeZone(db(), TIME_ZONE);
    }
  });

  test("a timezone PostgreSQL does not know stops the run before anything is deleted", async () => {
    const id = await project(30);
    await events(id, ["2020-01-01T00:00:00Z"]);
    // The settings page refuses such a name; as if one had been written by hand.
    await setInstanceTimeZone(db(), "Nowhere/Nothing");
    try {
      await expect(deleteExpiredEvents(db(), clickhouse(), { now: NOW })).rejects.toThrow(
        /time zone "Nowhere\/Nothing" not recognized/,
      );
    } finally {
      await setInstanceTimeZone(db(), TIME_ZONE);
    }
    expect(await remainingInClickHouse(id)).toEqual(["2020-01-01T00:00:00.000Z"]);
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

/** One row in each telemetry table at each time, as a project's own. */
async function telemetry(projectId: string, times: Date[]) {
  for (const table of TELEMETRY_TABLES) {
    await clickhouse().insert({
      table,
      values: times.map((time) => ({
        project_id: projectId,
        timestamp: clickHouseTime(time),
        id: randomUUID(),
        ...(table === "spans" || table === "logs" ? {} : { name: "requests" }),
      })),
      format: "JSONEachRow",
    });
  }
}

/** The project's rows left in each telemetry table, as pages see them. */
async function telemetryLeft(projectId: string): Promise<Record<string, string[]>> {
  const left: Record<string, string[]> = {};
  for (const table of TELEMETRY_TABLES) {
    const result = await clickhouse().query({
      query: `SELECT toString(timestamp) AS at FROM ${table}
              WHERE project_id = {project:UUID} ORDER BY timestamp`,
      query_params: { project: projectId },
      format: "JSONEachRow",
    });
    const rows = await result.json<{ at: string }>();
    left[table] = rows.map((row) => fromClickHouseTime(row.at).toISOString());
  }
  return left;
}

const inEveryTable = (times: Date[]) =>
  Object.fromEntries(
    TELEMETRY_TABLES.map((table) => [table, times.map((time) => time.toISOString())]),
  );

/** A project that keeps its telemetry `days` days; null for the instance's maximum. */
async function keepingTelemetry(days: number | null) {
  const { id } = await insertProject(db(), {
    name: "Telemetry retention test",
    telemetry_retention_days: days,
  });
  return id;
}

// ClickHouse's TTL keeps 30 days in tests and counts from the real time, so
// these rows are recent: the cut-off is the midnight UTC 7 days before today.
describe("deleteExpiredTelemetry", { timeout: 60_000 }, () => {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutOff = new Date(today - 7 * 86_400_000);
  const justBefore = new Date(cutOff.getTime() - 1);
  const older = new Date(cutOff.getTime() - 3 * 86_400_000);
  const recent = new Date(today);

  test("deletes a shorter-keeping project's old traces, logs, and metrics by whole UTC days, and no other project's", async () => {
    const week = await keepingTelemetry(7);
    const atMaximum = await keepingTelemetry(null);
    const sameAsMaximum = await keepingTelemetry(30);
    const all = [older, justBefore, cutOff, recent];
    for (const id of [week, atMaximum, sameAsMaximum]) await telemetry(id, all);

    const results = await deleteExpiredTelemetry(db(), clickhouse(), { maxDays: 30, now });

    expect(results.find((result) => result.projectId === week)).toEqual({
      projectId: week,
      before: cutOff,
      deleted: 2 * TELEMETRY_TABLES.length,
    });
    // Projects at the maximum are left to ClickHouse's TTL.
    const touched = results.map((result) => result.projectId);
    expect(touched).not.toContain(atMaximum);
    expect(touched).not.toContain(sameAsMaximum);
    expect(await telemetryLeft(week)).toEqual(inEveryTable([cutOff, recent]));
    expect(await telemetryLeft(atMaximum)).toEqual(inEveryTable(all));
    expect(await telemetryLeft(sameAsMaximum)).toEqual(inEveryTable(all));

    // Running it again deletes nothing more.
    const again = await deleteExpiredTelemetry(db(), clickhouse(), { maxDays: 30, now });
    expect(again.find((result) => result.projectId === week)).toMatchObject({ deleted: 0 });
  });

  test("a lower maximum caps a longer setting, and leaves the project to the TTL", async () => {
    const longer = await keepingTelemetry(30);
    await telemetry(longer, [justBefore, recent]);

    // The operator lowered TELEMETRY_RETENTION_DAYS to 7: the project counts
    // as 7, which ClickHouse's TTL then drops for every project.
    const results = await deleteExpiredTelemetry(db(), clickhouse(), { maxDays: 7, now });

    expect(results.map((result) => result.projectId)).not.toContain(longer);
  });

  test("the database refuses a telemetry retention under 1 day or over 365", async () => {
    await expect(keepingTelemetry(0)).rejects.toThrow(/check/);
    await expect(keepingTelemetry(366)).rejects.toThrow(/check/);
  });
});

describe("effectiveTelemetryRetentionDays", () => {
  test("the project's days, the maximum without them, and never more than the maximum", () => {
    expect(effectiveTelemetryRetentionDays(7, 30)).toBe(7);
    expect(effectiveTelemetryRetentionDays(null, 30)).toBe(30);
    expect(effectiveTelemetryRetentionDays(90, 30)).toBe(30);
  });
});
