import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { nanosText } from "../src/telemetry/normalize.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/**
 * Yesterday, month to date, and year to date on the pages outside Web
 * analytics that share its periods (docs/dashboard.md, "Periods").
 */

/** Summer time ends on 1 November 2026 and starts on 8 March 2026. */
const TIME_ZONE = "America/New_York";
/** 10:30 on Saturday 28 November in New York. Never the real clock. */
const NOW = new Date("2026-11-28T15:30:00Z");
let now = NOW;

/**
 * One signup each, by a visitor and a user of its own, after a pageview of
 * "/" a minute before it unless `page` says when.
 */
const SIGNUPS: { at: string; page?: string }[] = [
  // Year to date's year before: 1 June, and 10:00 and 11:00 on 28 November 2025.
  { at: "2025-06-01T12:00:00Z" },
  { at: "2025-11-28T15:00:00Z" },
  { at: "2025-11-28T16:00:00Z" },
  // 23:30 on 31 December 2025, then 00:30 on 1 January 2026.
  { at: "2026-01-01T04:30:00Z" },
  { at: "2026-01-01T05:30:00Z" },
  // Month to date's month before: 10:00 on 28 October, and 11:00 after a
  // pageview at 10:29, before the cut-off.
  { at: "2026-10-28T14:00:00Z" },
  { at: "2026-10-28T15:00:00Z", page: "2026-10-28T14:29:00Z" },
  // 23:30 on 31 October, then 00:30 on 1 November, still summer time.
  { at: "2026-11-01T03:30:00Z" },
  { at: "2026-11-01T04:30:00Z" },
  // The day before yesterday, yesterday at 09:00 and 23:30, and today at 09:00.
  { at: "2026-11-26T14:00:00Z" },
  { at: "2026-11-27T14:00:00Z" },
  { at: "2026-11-28T04:30:00Z" },
  { at: "2026-11-28T14:00:00Z" },
];

function eventsOf(): NewEvent[] {
  return SIGNUPS.flatMap(({ at, page }, index) => {
    const who = { visitorId: String(index + 1), userId: `user-${index + 1}` };
    const signupAt = new Date(at);
    return [
      {
        eventId: randomUUID(),
        name: "pageview",
        occurredAt: page === undefined ? new Date(signupAt.getTime() - 60_000) : new Date(page),
        path: "/",
        ...who,
      },
      { eventId: randomUUID(), name: "signup", occurredAt: signupAt, path: "/", ...who },
    ];
  });
}

/** AI calls at 10:00 and 11:00 on 28 October, and yesterday at 09:00. */
const AI_CALLS = ["2026-10-28T14:00:00Z", "2026-10-28T15:00:00Z", "2026-11-27T14:00:00Z"];

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";

beforeAll(async () => {
  dashboard = await signedInDashboard({ timeZone: TIME_ZONE, now: () => now });
  projectId = (await insertProject(dashboard.db, { name: "Periods" })).id;
  await dashboard.store(projectId, eventsOf());
  await dashboard.reader.client.insert({
    table: "ai_calls",
    values: AI_CALLS.map((at, index) => ({
      project_id: projectId,
      timestamp: nanosText(BigInt(Date.parse(at)) * 1_000_000n),
      id: `call-${index}`,
      model: "gpt-4o-mini",
      environment: "production",
      input_tokens: 10,
    })),
    format: "JSONEachRow",
  });
});

afterAll(async () => {
  await dashboard?.close();
});

async function get(path: string) {
  const response = await dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie: dashboard.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function refused(path: string) {
  const response = await dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie: dashboard.cookie },
  });
  return response.statusCode;
}

const signups = async (query: string) => {
  const body = await get(`/events?${query}`);
  const row = body.events.find((item: { name: string }) => item.name === "signup");
  return { body, events: row?.events ?? 0, previous: row?.previous.events ?? 0 };
};

const FUNNEL = `/funnel?steps=${encodeURIComponent(
  JSON.stringify([
    { type: "page", path: "/" },
    { type: "event", name: "signup" },
  ]),
)}&count=visitors&window=86400`;

describe("the days of each period, in the instance's timezone", () => {
  test("yesterday is the whole local day before today, compared with the day before it", async () => {
    const { body, events, previous } = await signups("period=yesterday");
    expect(body).toMatchObject({
      firstDay: "2026-11-27",
      lastDay: "2026-11-27",
      previous: { firstDay: "2026-11-26", lastDay: "2026-11-26", until: null },
    });
    // 23:30 local is yesterday, though it is already the 28th in UTC.
    expect({ events, previous }).toEqual({ events: 2, previous: 1 });
  });

  test("month to date starts at local midnight on the 1st", async () => {
    const { body, events } = await signups("period=mtd");
    expect(body).toMatchObject({ firstDay: "2026-11-01", lastDay: "2026-11-28" });
    // 00:30 on 1 November counts; 23:30 on 31 October does not.
    expect(events).toBe(5);
  });

  test("year to date starts at local midnight on 1 January", async () => {
    const { body, events } = await signups("period=ytd");
    expect(body).toMatchObject({ firstDay: "2026-01-01", lastDay: "2026-11-28" });
    expect(events).toBe(9);
  });

  test("an unknown period is refused", async () => {
    expect(await refused("/events?period=all")).toBe(400);
    expect(await refused("/events?period=24h")).toBe(400);
  });
});

describe("the period before", () => {
  test("month to date compares with the same days of the month before, up to now's time", async () => {
    const { body, previous } = await signups("period=mtd");
    expect(body.previous).toEqual({
      firstDay: "2026-10-01",
      lastDay: "2026-10-28",
      // 10:30 on 28 October, summer time.
      until: "2026-10-28T14:30:00.000Z",
    });
    // 10:00 on the 28th counts; 11:00 is after the cut-off.
    expect(previous).toBe(1);
  });

  test("year to date compares with the same days of the year before, up to now's time", async () => {
    const { body, previous } = await signups("period=ytd");
    expect(body.previous).toEqual({
      firstDay: "2025-01-01",
      lastDay: "2025-11-28",
      until: "2025-11-28T15:30:00.000Z",
    });
    expect(previous).toBe(2);
  });

  test("a month before a longer month stops at the shorter one's end, at now's time", async () => {
    now = new Date("2026-03-31T14:00:00Z");
    try {
      const { body } = await signups("period=mtd");
      expect(body).toMatchObject({
        firstDay: "2026-03-01",
        lastDay: "2026-03-31",
        // 10:00 on 28 February, before summer time.
        previous: {
          firstDay: "2026-02-01",
          lastDay: "2026-02-28",
          until: "2026-02-28T15:00:00.000Z",
        },
      });
    } finally {
      now = NOW;
    }
  });

  test("an event's page compares the same way", async () => {
    const body = await get("/events/signup?period=mtd");
    expect(body.previous).toMatchObject({
      firstDay: "2026-10-01",
      lastDay: "2026-10-28",
      until: "2026-10-28T14:30:00.000Z",
      events: 1,
    });
  });

  test("a funnel's later steps of the month before stop at the cut-off", async () => {
    const body = await get(`${FUNNEL}&period=mtd`);
    expect(body.steps.map((step: { reached: number }) => step.reached)).toEqual([5, 5]);
    // The 10:29 pageview counts; its signup at 11:00 comes after 10:30.
    expect(body.previous).toEqual({
      firstDay: "2026-10-01",
      lastDay: "2026-10-28",
      until: "2026-10-28T14:30:00.000Z",
      reached: [2, 1],
    });
  });

  test("active users compare year to date with the year before", async () => {
    const body = await get("/active-users?period=ytd");
    expect(body).toMatchObject({ firstDay: "2026-01-01", lastDay: "2026-11-28", unit: "week" });
    expect(body.summary.users).toBe(9);
    expect(body.previous).toMatchObject({
      firstDay: "2025-01-01",
      lastDay: "2025-11-28",
      until: "2025-11-28T15:30:00.000Z",
      users: 2,
    });
  });

  test("AI usage compares month to date with the month before", async () => {
    const body = await get("/ai?period=mtd");
    expect(body.totals.calls).toBe(1);
    expect(body.previous).toMatchObject({
      firstDay: "2026-10-01",
      lastDay: "2026-10-28",
      until: "2026-10-28T14:30:00.000Z",
      totals: { calls: 1 },
    });
    expect(await get("/ai?period=yesterday")).toMatchObject({
      firstDay: "2026-11-27",
      lastDay: "2026-11-27",
      totals: { calls: 1 },
      previous: { firstDay: "2026-11-26", lastDay: "2026-11-26", until: null },
    });
  });
});

describe("the Overview", () => {
  test("takes yesterday and month to date, each with its period before", async () => {
    expect(await get("/overview/traffic?period=yesterday")).toMatchObject({
      firstDay: "2026-11-27",
      lastDay: "2026-11-27",
      previous: { firstDay: "2026-11-26", lastDay: "2026-11-26" },
      summary: { visitors: 2 },
      previousSummary: { visitors: 1 },
    });
    expect(await get("/overview/traffic?period=mtd")).toMatchObject({
      firstDay: "2026-11-01",
      lastDay: "2026-11-28",
      previous: { firstDay: "2026-10-01", lastDay: "2026-10-28" },
      summary: { visitors: 5 },
      // Both pageviews of 28 October came before 10:30.
      previousSummary: { visitors: 2 },
    });
  });

  test("refuses year to date: its periods run a month at most", async () => {
    expect(await refused("/overview/traffic?period=ytd")).toBe(400);
  });
});

describe("other pages", () => {
  test("retention takes year to date", async () => {
    expect(await get("/retention?period=ytd")).toMatchObject({
      firstDay: "2026-01-01",
      lastDay: "2026-11-28",
    });
  });

  test("errors take the three periods", async () => {
    expect(await get("/errors?period=yesterday")).toMatchObject({
      firstDay: "2026-11-27",
      lastDay: "2026-11-27",
    });
    expect(await get("/errors?period=mtd")).toMatchObject({ firstDay: "2026-11-01" });
    expect(await get("/errors?period=ytd")).toMatchObject({ firstDay: "2026-01-01" });
  });

  test("heatmaps cut year to date to the 90 days they keep", async () => {
    expect(await get("/heatmaps/pages?period=ytd")).toMatchObject({
      clipped: true,
      firstDay: "2026-08-31",
      lastDay: "2026-11-28",
    });
    expect(await get("/heatmaps/pages?period=mtd")).toMatchObject({
      clipped: false,
      firstDay: "2026-11-01",
    });
    expect(await get("/heatmaps/pages?period=yesterday")).toMatchObject({
      clipped: false,
      firstDay: "2026-11-27",
      lastDay: "2026-11-27",
    });
  });
});
