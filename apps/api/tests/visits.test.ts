import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { copyEventsToClickHouse } from "../src/clickhouse/copy-events.ts";
import type { Reader } from "../src/clickhouse/query.ts";
import { type NewEvent, storeEvents } from "../src/collection/event-store.ts";
import { findVisits } from "../src/visits/visits.ts";
import { insertProject } from "./helpers/projects.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

let testDb: TestDatabase | undefined;
let testClickHouse: TestClickHouse | undefined;

beforeAll(async () => {
  // One after the other: if the second fails, afterAll still drops the first.
  testDb = await createTestDatabase();
  testClickHouse = await createTestClickHouse();
});

afterAll(async () => {
  await testDb?.destroy();
  await testClickHouse?.destroy();
});

/** ClickHouse, with every stored event copied there, as the worker does. */
async function reader(): Promise<Reader> {
  if (testClickHouse === undefined) throw new Error("The test ClickHouse was not created");
  await copyEventsToClickHouse(db(), testClickHouse.client);
  return { client: testClickHouse.client };
}

function db() {
  if (testDb === undefined) throw new Error("The test database was not created");
  return testDb.db;
}

async function createProject(): Promise<string> {
  const row = await insertProject(db(), {
    name: "Visits test",
    allowed_hostnames: ["example.com"],
  });
  return row.id;
}

/** One stored event: a time on 16 November 2026 (UTC) unless a full timestamp is given. */
function event(
  visitorId: string,
  time: string,
  path: string,
  overrides: Partial<NewEvent> = {},
): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date(time.includes("T") ? time : `2026-11-16T${time}:00Z`),
    path,
    visitorId,
    ...overrides,
  };
}

function engagement(visitorId: string, time: string, path: string, engagedMs: number): NewEvent {
  return event(visitorId, time, path, { name: "engagement", properties: { engagedMs } });
}

/** Visitor IDs are 64-bit integers; these names keep the tests readable. */
const YESTERDAY_ID = "101";
const TODAY_ID = "102";
const EARLY = "201";
const INSIDE = "202";
const LATE = "203";

const DAY = {
  environment: "production",
  from: new Date("2026-11-16T00:00:00Z"),
  to: new Date("2026-11-17T00:00:00Z"),
};
const minutes = (n: number) => n * 60 * 1000;

describe("findVisits", () => {
  test("a visit is a run of events with no gap over 30 minutes", async () => {
    const projectId = await createProject();
    await storeEvents(db(), projectId, [
      event("1", "10:00", "/"),
      event("1", "10:10", "/pricing"),
      event("1", "10:39", "/docs"), // 29 minutes later: same visit
      event("1", "11:10", "/pricing"), // 31 minutes later: a new visit
    ]);

    const visits = await findVisits(await reader(), { projectId, ...DAY });

    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({
      visitorId: "1",
      startedAt: new Date("2026-11-16T10:00:00Z"),
      endedAt: new Date("2026-11-16T10:39:00Z"),
      durationMs: minutes(39),
      pageviews: 3,
      entryPath: "/",
      exitPath: "/docs",
      bounce: false,
    });
    expect(visits[1]).toMatchObject({
      pageviews: 1,
      entryPath: "/pricing",
      exitPath: "/pricing",
      durationMs: 0,
      bounce: true,
    });
  });

  test("a gap of exactly 30 minutes keeps the visit going", async () => {
    const projectId = await createProject();
    await storeEvents(db(), projectId, [event("1", "10:00", "/"), event("1", "10:30", "/docs")]);
    expect(await findVisits(await reader(), { projectId, ...DAY })).toHaveLength(1);
  });

  test("keeps different visitors' visits apart, even when their events interleave", async () => {
    const projectId = await createProject();
    await storeEvents(db(), projectId, [
      event("1", "10:00", "/"),
      event("2", "10:01", "/pricing"),
      event("1", "10:02", "/docs"),
      event("2", "10:03", "/signup"),
    ]);
    const visits = await findVisits(await reader(), { projectId, ...DAY });
    expect(visits.map((v) => [v.visitorId, v.entryPath, v.exitPath])).toEqual([
      ["1", "/", "/docs"],
      ["2", "/pricing", "/signup"],
    ]);
  });

  describe("bounces", () => {
    test("one pageview and nothing else is a bounce", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [event("1", "10:00", "/pricing")]);
      const [visit] = await findVisits(await reader(), { projectId, ...DAY });
      expect(visit).toMatchObject({ pageviews: 1, interactions: 0, bounce: true });
    });

    test("a custom event means the visitor interacted: not a bounce", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [
        event("1", "10:00", "/pricing"),
        event("1", "10:02", "/pricing", { name: "signup" }),
      ]);
      const [visit] = await findVisits(await reader(), { projectId, ...DAY });
      expect(visit).toMatchObject({ pageviews: 1, interactions: 1, bounce: false });
    });
  });

  describe("engagement (time on page)", () => {
    test("extends the visit and adds engaged time without changing the bounce", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [
        event("1", "10:00", "/blog/post"),
        engagement("1", "10:04", "/blog/post", minutes(4)),
      ]);
      const [visit] = await findVisits(await reader(), { projectId, ...DAY });
      expect(visit).toMatchObject({
        pageviews: 1,
        bounce: true, // A long read is still one page.
        endedAt: new Date("2026-11-16T10:04:00Z"),
        durationMs: minutes(4),
        engagedMs: minutes(4),
      });
    });

    test("never starts a visit on its own", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [
        event("1", "10:00", "/"),
        // The tab stayed open 45 minutes with no event: too late to belong to the visit.
        engagement("1", "10:45", "/", minutes(45)),
        engagement("2", "12:00", "/", 5000),
      ]);
      const visits = await findVisits(await reader(), { projectId, ...DAY });
      expect(visits).toHaveLength(1);
      expect(visits[0]).toMatchObject({ visitorId: "1", durationMs: 0, engagedMs: 0 });
    });

    test("does not give a late report's time to the visit that starts after it", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [
        event("1", "10:00", "/blog/post"),
        // After a 45-minute read, the visitor clicks a link. The tracker reports the
        // old page's time and the new pageview at the same moment. These IDs sort the
        // pageview first, so only the engagement-first rule puts the report before it.
        {
          ...engagement("1", "10:45", "/blog/post", minutes(45)),
          eventId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
        },
        { ...event("1", "10:45", "/pricing"), eventId: "00000000-0000-4000-8000-000000000000" },
        engagement("1", "10:47", "/pricing", minutes(2)),
      ]);
      const visits = await findVisits(await reader(), { projectId, ...DAY });
      expect(visits.map((v) => [v.entryPath, v.engagedMs])).toEqual([
        ["/blog/post", 0],
        ["/pricing", minutes(2)], // Only the new page's own time.
      ]);
    });

    test("counts a malformed engagement time as 0 instead of failing the report", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [
        event("1", "10:00", "/"),
        event("1", "10:01", "/", { name: "engagement", properties: { engagedMs: "lots" } }),
      ]);
      const [visit] = await findVisits(await reader(), { projectId, ...DAY });
      expect(visit?.engagedMs).toBe(0);
    });
  });

  describe("late, out-of-order, and repeated events", () => {
    test("gives the same visits whatever order events arrive in", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [event("1", "10:20", "/docs")]);
      await storeEvents(db(), projectId, [event("1", "10:00", "/")]);
      const [visit] = await findVisits(await reader(), { projectId, ...DAY });
      expect(visit).toMatchObject({ entryPath: "/", exitPath: "/docs", pageviews: 2 });
    });

    test("joins two visits when a late event fills the gap between them", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [event("1", "10:00", "/"), event("1", "11:00", "/docs")]);
      expect(await findVisits(await reader(), { projectId, ...DAY })).toHaveLength(2);

      // A phone was offline; its 10:30 pageview arrives afterwards.
      await storeEvents(db(), projectId, [event("1", "10:30", "/pricing")]);
      const visits = await findVisits(await reader(), { projectId, ...DAY });
      expect(visits).toHaveLength(1);
      expect(visits[0]).toMatchObject({ pageviews: 3, entryPath: "/", exitPath: "/docs" });
    });

    test("does not count a retried event twice", async () => {
      const projectId = await createProject();
      const batch = [event("1", "10:00", "/"), event("1", "10:05", "/docs")];
      await storeEvents(db(), projectId, batch);
      await storeEvents(db(), projectId, batch);
      const [visit] = await findVisits(await reader(), { projectId, ...DAY });
      expect(visit?.pageviews).toBe(2);
    });
  });

  describe("midnight", () => {
    // Visitor IDs change at midnight in the instance's timezone. Joining the
    // two IDs would link a visitor across days, so the visit splits.
    test("counts a visit that crosses midnight as two", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [
        event(YESTERDAY_ID, "2026-11-16T23:50:00Z", "/"),
        event(TODAY_ID, "2026-11-17T00:05:00Z", "/pricing"),
        event(TODAY_ID, "2026-11-17T00:25:00Z", "/docs"),
      ]);
      const visits = await findVisits(await reader(), {
        projectId,
        environment: "production",
        from: new Date("2026-11-16T00:00:00Z"),
        to: new Date("2026-11-18T00:00:00Z"),
      });
      expect(visits.map((v) => [v.visitorId, v.pageviews, v.entryPath, v.exitPath])).toEqual([
        [YESTERDAY_ID, 1, "/", "/"],
        [TODAY_ID, 2, "/pricing", "/docs"],
      ]);
    });
  });

  describe("the time range", () => {
    test("counts a visit in the range where it started, with its events after the range end", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [
        event(EARLY, "09:50", "/"), // Started before 10:00 …
        event(EARLY, "10:05", "/docs"), // … so not counted, though this event is inside.
        event(INSIDE, "11:50", "/"),
        event(INSIDE, "12:10", "/docs"), // After the range end, but part of the visit.
        event(LATE, "12:05", "/"), // Started after the range: not counted.
      ]);
      const visits = await findVisits(await reader(), {
        projectId,
        environment: "production",
        from: new Date("2026-11-16T10:00:00Z"),
        to: new Date("2026-11-16T12:00:00Z"),
      });
      expect(visits).toHaveLength(1);
      expect(visits[0]).toMatchObject({
        visitorId: INSIDE,
        pageviews: 2,
        exitPath: "/docs",
        durationMs: minutes(20),
        bounce: false,
      });
    });

    test("reads far enough back to see where a visit started", async () => {
      const projectId = await createProject();
      await storeEvents(db(), projectId, [
        event(EARLY, "09:10", "/"),
        // Engagement reports keep the visit going, though no page is viewed
        // in the 30 minutes before the range starts.
        engagement(EARLY, "09:35", "/", 60_000),
        engagement(EARLY, "09:55", "/", 60_000),
        event(EARLY, "10:10", "/docs"),
      ]);
      const range = { projectId, environment: "production", to: new Date("2026-11-16T12:00:00Z") };
      // The visit started at 09:10, before the range: not counted.
      expect(
        await findVisits(await reader(), { ...range, from: new Date("2026-11-16T10:00:00Z") }),
      ).toEqual([]);
      const [visit] = await findVisits(await reader(), {
        ...range,
        from: new Date("2026-11-16T09:00:00Z"),
      });
      expect(visit).toMatchObject({ startedAt: new Date("2026-11-16T09:10:00Z"), pageviews: 2 });
    });
  });

  test("takes the referrer, campaign, browser, and location from the visit's first event", async () => {
    const projectId = await createProject();
    await storeEvents(db(), projectId, [
      event("1", "10:00", "/", {
        referrer: "https://www.google.com/",
        utm: { source: "newsletter", campaign: "launch" },
        client: { browser: "Firefox", os: "Android", deviceType: "mobile" },
        location: { country: "DE", region: "Bavaria", city: "Munich" },
      }),
      event("1", "10:05", "/docs", {
        referrer: "https://example.com/",
        client: { browser: "Chrome" },
        location: { country: "FR" },
      }),
    ]);
    const [visit] = await findVisits(await reader(), { projectId, ...DAY });
    expect(visit).toMatchObject({
      referrer: "https://www.google.com/",
      utmSource: "newsletter",
      utmCampaign: "launch",
      browser: "Firefox",
      os: "Android",
      deviceType: "mobile",
      country: "DE",
      region: "Bavaria",
      city: "Munich",
    });
  });

  test("counts one environment at a time, even for the same visitor ID", async () => {
    const projectId = await createProject();
    // A developer opens the live site, then the staging site, then the live
    // one again: one visitor ID on both, the same day.
    await storeEvents(db(), projectId, [
      event("1", "10:00", "/", { release: "1.4.2" }),
      event("1", "10:05", "/new-feature", { environment: "staging", release: "1.5.0-rc.1" }),
      event("1", "10:10", "/docs", { release: "1.4.2" }),
    ]);

    const live = await findVisits(await reader(), { projectId, ...DAY });
    expect(live).toMatchObject([
      { pageviews: 2, entryPath: "/", exitPath: "/docs", release: "1.4.2" },
    ]);
    const staging = await findVisits(await reader(), {
      projectId,
      ...DAY,
      environment: "staging",
    });
    expect(staging).toMatchObject([
      { pageviews: 1, entryPath: "/new-feature", release: "1.5.0-rc.1" },
    ]);
  });

  test("keeps what the first event lacks, even when a later event has it", async () => {
    const projectId = await createProject();
    await storeEvents(db(), projectId, [
      event("1", "10:00", "/"),
      event("1", "10:05", "/docs", {
        referrer: "https://example.com/",
        utm: { source: "newsletter" },
        client: { browser: "Chrome" },
        location: { country: "FR" },
      }),
    ]);
    const [visit] = await findVisits(await reader(), { projectId, ...DAY });
    expect(visit).toMatchObject({ referrer: null, utmSource: null, browser: null, country: null });
  });

  test("ignores events stored before visitor IDs existed", async () => {
    const projectId = await createProject();
    await storeEvents(db(), projectId, [
      {
        eventId: randomUUID(),
        name: "pageview",
        occurredAt: new Date("2026-11-16T10:00:00Z"),
        path: "/",
      },
    ]);
    expect(await findVisits(await reader(), { projectId, ...DAY })).toEqual([]);
  });
});
