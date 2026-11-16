import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { canonicalTimeZone, dayIn, visitorId, VisitorIds } from "../src/visitors/visitor-ids.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0";

describe("dayIn", () => {
  test("gives the calendar day in the timezone, not in UTC", () => {
    const moment = new Date("2026-11-15T23:30:00Z");
    expect(dayIn("UTC")(moment)).toBe("2026-11-15");
    expect(dayIn("Asia/Singapore")(moment)).toBe("2026-11-16"); // 07:30 the next morning
    expect(dayIn("America/Los_Angeles")(moment)).toBe("2026-11-15"); // 15:30 the same day
  });

  test("handles daylight saving time changes", () => {
    // New York moves its clocks forward on 8 March 2026.
    const newYork = dayIn("America/New_York");
    expect(newYork(new Date("2026-03-08T04:30:00Z"))).toBe("2026-03-07"); // 23:30 EST
    expect(newYork(new Date("2026-03-08T05:30:00Z"))).toBe("2026-03-08"); // 00:30 EST
  });
});

describe("canonicalTimeZone", () => {
  test.each([
    ["Asia/Singapore", "Asia/Singapore"],
    ["singapore", "Asia/Singapore"],
    ["utc", "UTC"],
    ["GMT", "UTC"],
    ["US/Pacific", "America/Los_Angeles"],
    ["Europe/Berlin", "Europe/Berlin"],
  ])("turns %j into %j", (name, official) => {
    expect(canonicalTimeZone(name)).toBe(official);
  });

  test.each(["Mars/Olympus_Mons", "Asia/Atlantis", "GMT+25", "singapore time", ""])(
    "rejects %j",
    (name) => {
      expect(canonicalTimeZone(name)).toBeUndefined();
    },
  );
});

describe("visitorId", () => {
  const salt = randomBytes(32);

  test("is the same for the same inputs", () => {
    expect(visitorId(salt, PROJECT, "46.4.0.1", CHROME)).toBe(
      visitorId(salt, PROJECT, "46.4.0.1", CHROME),
    );
  });

  test("is a signed 64-bit integer that does not contain the IP address", () => {
    const id = visitorId(salt, PROJECT, "46.4.0.1", CHROME);
    expect(id).toMatch(/^-?\d{1,19}$/);
    expect(BigInt(id) >= -(2n ** 63n) && BigInt(id) < 2n ** 63n).toBe(true);
    expect(id).not.toContain("46");
  });

  test.each([
    ["the salt (a new day)", [randomBytes(32), PROJECT, "46.4.0.1", CHROME]],
    ["the project", [salt, OTHER_PROJECT, "46.4.0.1", CHROME]],
    ["the IP address", [salt, PROJECT, "46.4.0.2", CHROME]],
    ["the browser", [salt, PROJECT, "46.4.0.1", FIREFOX]],
  ] as const)("changes with %s", (_label, [otherSalt, project, ip, userAgent]) => {
    expect(visitorId(otherSalt, project, ip, userAgent)).not.toBe(
      visitorId(salt, PROJECT, "46.4.0.1", CHROME),
    );
  });
});

/** One page view from a test visitor. */
const visit = (occurredAt: string, overrides: { ip?: string; userAgent?: string } = {}) => ({
  projectId: PROJECT,
  ip: overrides.ip ?? "46.4.0.1",
  userAgent: overrides.userAgent ?? CHROME,
  occurredAt: new Date(occurredAt),
});

describe("VisitorIds", () => {
  let testDb: TestDatabase | undefined;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb?.destroy();
  });

  function db() {
    if (testDb === undefined) throw new Error("The test database was not created");
    return testDb.db;
  }

  beforeEach(async () => {
    await db().deleteFrom("visitor_salts").execute();
  });

  /** A VisitorIds whose clock reads `iso`, as one API process would see it. */
  function visitorsAt(iso: string, timeZone = "UTC") {
    return new VisitorIds(db(), { timeZone, now: () => Date.parse(iso) });
  }

  async function salts() {
    return (await db().selectFrom("visitor_salts").select("day").orderBy("day").execute()).map(
      (row) => row.day,
    );
  }

  test("gives one visitor the same ID all day, across restarts and processes", async () => {
    const morning = await visitorsAt("2026-11-16T08:00:00Z").idFor(visit("2026-11-16T08:00:00Z"));
    // Another process (or the API after a restart) reads the same salt from PostgreSQL.
    const evening = await visitorsAt("2026-11-16T20:00:00Z").idFor(visit("2026-11-16T20:00:00Z"));
    expect(evening).toBe(morning);
  });

  test("gives the same visitor a new ID the next day", async () => {
    const monday = await visitorsAt("2026-11-16T12:00:00Z").idFor(visit("2026-11-16T12:00:00Z"));
    const tuesday = await visitorsAt("2026-11-17T12:00:00Z").idFor(visit("2026-11-17T12:00:00Z"));
    expect(tuesday).not.toBe(monday);
  });

  test("tells apart visitors on different networks or browsers", async () => {
    const visitors = visitorsAt("2026-11-16T12:00:00Z");
    const ids = await Promise.all([
      visitors.idFor(visit("2026-11-16T12:00:00Z")),
      visitors.idFor(visit("2026-11-16T12:00:00Z", { ip: "81.2.69.160" })),
      visitors.idFor(visit("2026-11-16T12:00:00Z", { userAgent: FIREFOX })),
    ]);
    expect(new Set(ids).size).toBe(3);
  });

  test("starts a new day at midnight in the instance's timezone", async () => {
    // 07:30 and 08:30 in Singapore are the same local day but different UTC days.
    const beforeUtcMidnight = "2026-11-16T23:30:00Z";
    const afterUtcMidnight = "2026-11-17T00:30:00Z";

    const singapore = visitorsAt(afterUtcMidnight, "Asia/Singapore");
    expect(await singapore.idFor(visit(beforeUtcMidnight))).toBe(
      await singapore.idFor(visit(afterUtcMidnight)),
    );

    const utc = visitorsAt(afterUtcMidnight, "UTC");
    expect(await utc.idFor(visit(beforeUtcMidnight))).not.toBe(
      await utc.idFor(visit(afterUtcMidnight)),
    );
  });

  test("gives a late event the ID of the day it happened", async () => {
    const lateEvening = "2026-11-16T23:50:00Z";
    const sameDay = await visitorsAt(lateEvening).idFor(visit(lateEvening));
    // The same event arrives ten minutes after midnight.
    const arrivingLate = await visitorsAt("2026-11-17T00:10:00Z").idFor(visit(lateEvening));
    expect(arrivingLate).toBe(sameDay);
  });

  test("creates exactly one salt per day when many requests arrive at once", async () => {
    const processes = [visitorsAt("2026-11-16T00:00:01Z"), visitorsAt("2026-11-16T00:00:01Z")];
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, i) => processes[i % 2]!.idFor(visit("2026-11-16T00:00:01Z"))),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await salts()).toEqual(["2026-11-16"]);
  });

  test("deletes salts once no event can still need them", async () => {
    for (const day of ["2026-11-10", "2026-11-14", "2026-11-15", "2026-11-16"]) {
      await db()
        .insertInto("visitor_salts")
        .values({ day, salt: randomBytes(32) })
        .execute();
    }
    // At 09:00 on the 16th, events may still arrive from 09:00 on the 15th.
    const visitors = visitorsAt("2026-11-16T09:00:00Z");
    expect(visitors.oldestKeptDay()).toBe("2026-11-15");
    expect(await visitors.deleteExpiredSalts()).toBe(2);
    expect(await salts()).toEqual(["2026-11-15", "2026-11-16"]);
  });

  test("deletes expired salts when a new day starts", async () => {
    await db()
      .insertInto("visitor_salts")
      .values({ day: "2026-11-01", salt: randomBytes(32) })
      .execute();
    await visitorsAt("2026-11-16T00:00:05Z").idFor(visit("2026-11-16T00:00:05Z"));
    expect(await salts()).toEqual(["2026-11-16"]);
  });
});
