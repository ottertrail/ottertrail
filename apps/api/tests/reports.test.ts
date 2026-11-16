import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { type NewEvent, storeEvents } from "../src/collection/event-store.ts";
import {
  breakdown,
  customEvents,
  isVisitDimension,
  localDays,
  type ReportRange,
  summary,
  timeseries,
  topPages,
  type VisitDimension,
} from "../src/reports/reports.ts";
import { dayIn } from "../src/visitors/visitor-ids.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

let testDb: TestDatabase | undefined;
let projectId = "";
let range: ReportRange;

function db() {
  if (testDb === undefined) throw new Error("The test database was not created");
  return testDb.db;
}

function pv(visitorId: string, iso: string, path: string, extra: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date(iso),
    path,
    visitorId,
    ...extra,
  };
}

const DE = { country: "DE", region: "Bavaria", city: "Munich" };
const CHROME_MAC = { browser: "Chrome", os: "macOS", deviceType: "desktop" as const };
const SAFARI_IPHONE = { browser: "Safari", os: "iOS", deviceType: "mobile" as const };
const FIREFOX_ANDROID = { browser: "Firefox", os: "Android", deviceType: "mobile" as const };

/**
 * Two days in Singapore (UTC+8): 16 and 17 November 2026.
 * Times below are UTC; the comments give Singapore time.
 */
const EVENTS: NewEvent[] = [
  // Visitor 1, day 1: Google, two pages, a signup, a minute on /pricing. Not a bounce.
  pv("1", "2026-11-16T02:00:00Z", "/", {
    referrer: "https://www.google.com/search",
    location: DE,
    client: CHROME_MAC,
  }), // 10:00
  pv("1", "2026-11-16T02:05:00Z", "/pricing", { referrer: "https://example.com/" }),
  pv("1", "2026-11-16T02:06:00Z", "/pricing", { name: "signup" }),
  pv("1", "2026-11-16T02:07:00Z", "/pricing", {
    name: "engagement",
    properties: { engagedMs: 60_000 },
  }),
  // Visitor 2, day 1: a newsletter campaign, one page. A bounce.
  pv("2", "2026-11-16T05:00:00Z", "/pricing", {
    utm: { source: "newsletter", medium: "email", campaign: "launch" },
    location: { country: "US", region: "California", city: "Mountain View" },
    client: SAFARI_IPHONE,
  }), // 13:00
  // Visitor 3 reads across midnight. The visitor ID changes, and the visit splits in two.
  pv("3", "2026-11-16T15:50:00Z", "/docs", {
    referrer: "https://news.ycombinator.com/item",
    location: { country: "GB", region: "England", city: "London" },
    client: FIREFOX_ANDROID,
  }), // 23:50
  pv("33", "2026-11-16T16:05:00Z", "/"), // 00:05 on day 2
  // Visitor 4, day 2: from the Gmail app, then a second visit 40 minutes later. Two bounces.
  pv("4", "2026-11-17T03:00:00Z", "/", {
    referrer: "android-app://com.google.android.gm",
    location: { country: "DE" },
  }), // 11:00
  pv("4", "2026-11-17T03:40:00Z", "/docs", { location: { country: "DE" } }), // 11:40
  // Visitor 5, day 2: arrives from the site's own www hostname, so it is direct. A bounce.
  pv("5", "2026-11-17T06:00:00Z", "/docs", { referrer: "https://www.example.com/pricing" }), // 14:00
  // Visitor 1 again on day 2: a new day, a new ID. A bounce.
  pv("11", "2026-11-17T09:00:00Z", "/pricing", { referrer: "https://www.google.com/" }), // 17:00
];

beforeAll(async () => {
  testDb = await createTestDatabase();
  const project = await db()
    .insertInto("projects")
    .values({ name: "Reports test", allowed_hostnames: ["example.com", "www.example.com"] })
    .returning("id")
    .executeTakeFirstOrThrow();
  projectId = project.id;
  await storeEvents(db(), projectId, EVENTS);
  const days = await localDays(db(), "2026-11-16", "2026-11-17", "Asia/Singapore");
  range = { projectId, ...days, timeZone: "Asia/Singapore" };
});

afterAll(async () => {
  await testDb?.destroy();
});

const byValue = <T extends { value: string | null }>(rows: T[]) =>
  Object.fromEntries(rows.map((row) => [row.value ?? "(unknown)", row]));

describe("localDays", () => {
  test("turns calendar days in a timezone into an absolute range", () => {
    expect(range.from).toEqual(new Date("2026-11-15T16:00:00Z")); // Midnight in Singapore
    expect(range.to).toEqual(new Date("2026-11-17T16:00:00Z"));
  });

  test.each(["Asia/Singapore", "America/New_York", "Etc/GMT-8", "UTC"])(
    "starts days at the same moment as visitor IDs do in %s",
    async (timeZone) => {
      // 8 March 2026 is the 23-hour day in New York.
      const { from, to } = await localDays(db(), "2026-03-08", "2026-03-08", timeZone);
      const day = dayIn(timeZone);
      expect(day(from)).toBe("2026-03-08");
      expect(day(new Date(from.getTime() - 1))).toBe("2026-03-07");
      expect(day(new Date(to.getTime() - 1))).toBe("2026-03-08");
      expect(day(to)).toBe("2026-03-09");
    },
  );

  test("handles a 23-hour day when clocks go forward", async () => {
    const day = await localDays(db(), "2026-03-08", "2026-03-08", "America/New_York");
    expect(day).toEqual({
      from: new Date("2026-03-08T05:00:00Z"),
      to: new Date("2026-03-09T04:00:00Z"),
    });
  });
});

describe("summary", () => {
  test("counts visitors, pageviews, and visits by the documented rules", async () => {
    expect(await summary(db(), range)).toEqual({
      // IDs 1, 2, 3, 33, 4, 5, 11: visitor 1 and visitor 3 count once per day.
      visitors: 7,
      pageviews: 9,
      // 1, 2, 3, 33, 4 twice, 5, 11: the read across midnight counts as two visits.
      visits: 8,
      viewsPerVisit: 9 / 8,
      // Every visit but visitor 1's on day 1.
      bounceRate: 7 / 8,
      // 7 minutes (visitor 1, to the engagement report), over 8 visits.
      avgDurationMs: (7 * 60_000) / 8,
      avgEngagedMs: 60_000 / 8,
    });
  });

  test("returns zeros and no rates for a range without data", async () => {
    const empty = {
      ...range,
      ...(await localDays(db(), "2026-11-20", "2026-11-20", "Asia/Singapore")),
    };
    expect(await summary(db(), empty)).toEqual({
      visitors: 0,
      pageviews: 0,
      visits: 0,
      viewsPerVisit: null,
      bounceRate: null,
      avgDurationMs: null,
      avgEngagedMs: null,
    });
  });
});

describe("timeseries", () => {
  test("counts by local day, with the read across midnight on both days", async () => {
    expect(await timeseries(db(), range)).toEqual([
      { day: "2026-11-16", visitors: 3, pageviews: 4, visits: 3 },
      { day: "2026-11-17", visitors: 4, pageviews: 5, visits: 5 },
    ]);
  });

  test("splits days differently in another timezone", async () => {
    const utc = { ...range, timeZone: "UTC" };
    const days = await timeseries(db(), utc);
    // In UTC, the reads at 23:50 and 00:05 Singapore time both fall on 16 November.
    expect(days.find((d) => d.day === "2026-11-16")?.visitors).toBe(4);
  });

  test("includes days without data, with zeros", async () => {
    const week = {
      ...range,
      ...(await localDays(db(), "2026-11-16", "2026-11-19", "Asia/Singapore")),
    };
    const days = await timeseries(db(), week);
    expect(days.map((d) => d.day)).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
    ]);
    expect(days[3]).toEqual({ day: "2026-11-19", visitors: 0, pageviews: 0, visits: 0 });
  });
});

describe("topPages", () => {
  test("counts pageviews and visitors per path, with average time on page", async () => {
    const pages = Object.fromEntries((await topPages(db(), range)).map((row) => [row.path, row]));
    expect(pages).toEqual({
      "/": { path: "/", pageviews: 3, visitors: 3, avgEngagedMs: null },
      "/pricing": { path: "/pricing", pageviews: 3, visitors: 3, avgEngagedMs: 60_000 },
      "/docs": { path: "/docs", pageviews: 3, visitors: 3, avgEngagedMs: null },
    });
  });

  test("respects the limit", async () => {
    expect(await topPages(db(), range, 1)).toHaveLength(1);
  });
});

describe("breakdown", () => {
  test("sources: utm_source first, then the referring site without www, otherwise direct", async () => {
    const sources = await breakdown(db(), range, "source");
    expect(byValue(sources)).toMatchObject({
      // Visitor 1 on both days: two IDs, two visits, one of them a bounce.
      "google.com": { visitors: 2, visits: 2, bounceRate: 0.5 },
      newsletter: { visits: 1, bounceRate: 1 },
      "news.ycombinator.com": { visits: 1, bounceRate: 1 },
      "com.google.android.gm": { visits: 1 },
      // Visitor 3 after midnight, visitor 4's second visit, and visitor 5 coming from
      // www.example.com (the site itself).
      "Direct / none": { visitors: 3, visits: 3 },
    });
    expect(sources.map((row) => row.value)).not.toContain("example.com");
  });

  test("sources: an IPv6 address in a referrer is the whole host", async () => {
    const other = await db()
      .insertInto("projects")
      .values({ name: "IPv6 referrer", allowed_hostnames: ["example.com"] })
      .returning("id")
      .executeTakeFirstOrThrow();
    await storeEvents(db(), other.id, [
      pv("7", "2026-11-16T02:00:00Z", "/", { referrer: "https://[2001:db8::1]:8443/page" }),
    ]);
    const sources = await breakdown(db(), { ...range, projectId: other.id }, "source");
    expect(sources.map((row) => row.value)).toEqual(["[2001:db8::1]"]);
  });

  test("campaigns", async () => {
    expect(byValue(await breakdown(db(), range, "utmCampaign"))).toMatchObject({
      launch: { visits: 1 },
      "(unknown)": { visits: 7 },
    });
  });

  test("entry and exit pages come from each visit's first and last pageview", async () => {
    expect(byValue(await breakdown(db(), range, "entryPage"))).toMatchObject({
      "/": { visits: 3 },
      "/pricing": { visits: 2 },
      "/docs": { visits: 3 },
    });
    expect(byValue(await breakdown(db(), range, "exitPage"))).toMatchObject({
      "/pricing": { visits: 3 },
      "/": { visits: 2 },
      "/docs": { visits: 3 },
    });
  });

  test("locations come from each visit's first event; cities keep their country", async () => {
    const countries = await breakdown(db(), range, "country");
    expect(byValue(countries)).toMatchObject({
      DE: { visitors: 2, visits: 3 },
      US: { visits: 1 },
      // Visitor 3 before midnight; the visit after midnight starts with an event without a location.
      GB: { visits: 1 },
      "(unknown)": { visits: 3 },
    });
    expect(byValue(await breakdown(db(), range, "city"))).toMatchObject({
      "Munich, DE": { visits: 1 },
      "Mountain View, US": { visits: 1 },
      "London, GB": { visits: 1 },
    });
  });

  test("devices", async () => {
    expect(byValue(await breakdown(db(), range, "deviceType"))).toMatchObject({
      mobile: { visits: 2 },
      desktop: { visits: 1 },
      "(unknown)": { visits: 5 },
    });
  });

  test("respects the limit, and rejects dimensions outside the allow-list", async () => {
    expect(await breakdown(db(), range, "browser", 1)).toHaveLength(1);
    expect(isVisitDimension("country")).toBe(true);
    expect(isVisitDimension("path; drop table events")).toBe(false);
    await expect(
      breakdown(db(), range, "path; drop table events" as VisitDimension),
    ).rejects.toThrow(/Unknown breakdown dimension/);
  });
});

describe("customEvents", () => {
  test("counts custom events, not pageviews or engagement reports", async () => {
    expect(await customEvents(db(), range)).toEqual([{ name: "signup", events: 1, visitors: 1 }]);
  });
});
