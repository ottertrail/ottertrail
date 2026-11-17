import type { Analytics, BreakdownRow, DayPoint } from "../../src/lib/analytics-api.ts";
import {
  type ErrorDetail,
  type ErrorGroup,
  type ErrorList,
  isStatusFilter,
} from "../../src/lib/errors-api.ts";
import type { Organization } from "../../src/lib/organizations-api.ts";
import {
  type Funnel,
  isFunnelStep,
  type ProductEventDetail,
  type ProductEvents,
  type Retention,
} from "../../src/lib/product-api.ts";
import type { Project } from "../../src/lib/projects-api.ts";
import type { Speed } from "../../src/lib/speed-api.ts";
import type { Activity, User, UserActivity, UserList } from "../../src/lib/users-api.ts";

/**
 * Stands in for the Ottertrail API: browser tests check the pages, and the
 * API has its own tests against PostgreSQL. Responses follow the API's
 * shapes; the page checks them the same way as real ones.
 */
export interface FakeApi {
  signedIn: boolean;
  /** The signed-in user's organizations; PATCH changes them (the owner's only). */
  organizations: Organization[];
  projects: Project[];
  /** Answers GET /api/projects/:id/analytics. A Response stands for an error. */
  analytics: (
    projectId: string,
    period: string | null,
    query: URLSearchParams,
  ) => Analytics | Response | Promise<Analytics | Response>;
  /** Answers GET /api/projects/:id/analytics/list; by default, fakeList. */
  list: (query: URLSearchParams) => unknown;
  /** Answers GET /api/projects/:id/users; by default, fakeUsers. */
  users: (query: URLSearchParams) => UserList | Response;
  /** Answers GET /api/projects/:id/users/:userId; by default, fakeUser. */
  user: (userId: string, query: URLSearchParams) => UserActivity | Response;
  /** Answers GET /api/projects/:id/errors; by default, fakeErrors. */
  errors: (query: URLSearchParams, api: FakeApi) => ErrorList | Response;
  /** Answers GET /api/projects/:id/errors/:fingerprint; by default, fakeError. */
  error: (fingerprint: string, query: URLSearchParams, api: FakeApi) => ErrorDetail | Response;
  /** Answers PATCH /api/projects/:id/errors/:fingerprint; by default, changes `resolutions`. */
  setErrorStatus: (api: FakeApi, fingerprint: string, status: string) => Response;
  /** Resolved error groups by fingerprint, as error_resolutions holds them. */
  resolutions: Record<string, { resolvedAt: string; resolvedBy: string | null }>;
  /** Answers GET /api/projects/:id/speed; by default, fakeSpeed. */
  speed: (query: URLSearchParams) => Speed | Response;
  /** Answers GET /api/projects/:id/events; by default, fakeProductEvents. */
  productEvents: (query: URLSearchParams) => ProductEvents | Response;
  /** Answers GET /api/projects/:id/events/:name; by default, fakeProductEvent. */
  productEvent: (name: string, query: URLSearchParams) => ProductEventDetail | Response;
  /** Answers GET /api/projects/:id/funnel; by default, fakeFunnel. */
  funnel: (query: URLSearchParams) => Funnel | Response;
  /** Answers GET /api/projects/:id/retention; by default, fakeRetention. */
  retention: (query: URLSearchParams) => Retention | Response;
  /** Answers DELETE /api/projects/:id; by default, removes the project (204). */
  deleteProject: (api: FakeApi, id: string) => Response;
  /** Every path the page asked for, with its query, in order. */
  requests: string[];
  /** The bodies of requests that change something, such as a delete's confirmation. */
  bodies: { method: string; path: string; body: unknown }[];
}

/** 120 known users, user-1 seen most recently, searched and paged as the API does. */
export function fakeUsers(query: URLSearchParams): UserList {
  const search = (query.get("search") ?? "").toLowerCase();
  const offset = Number(query.get("offset") ?? 0);
  const all: User[] = Array.from({ length: 120 }, (_, i) => ({
    userId: `user-${i + 1}`,
    firstSeenAt: "2026-11-01T02:00:00.000Z",
    lastSeenAt: new Date(Date.UTC(2026, 10, 16, 8, 0) - i * 3_600_000).toISOString(),
    events: 120 - i,
  })).filter((user) => user.userId.includes(search));
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    environments: ["production"],
    users: all.slice(offset, offset + 50),
    hasMore: offset + 50 < all.length,
  };
}

/** Ada's activity: 150 pageviews and signups, newest first, paged back by cursor as the API does. */
export function fakeUser(userId: string, query: URLSearchParams): UserActivity | Response {
  if (userId !== "ada") {
    return json(
      { error: "not_found", message: "No event in this environment has this user ID." },
      404,
    );
  }
  const all: Activity[] = Array.from({ length: 150 }, (_, i) => ({
    eventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: i % 10 === 1 ? "signup" : "pageview",
    occurredAt: new Date(Date.UTC(2026, 10, 16, 8, 0) - i * 1_800_000).toISOString(),
    path: i % 10 === 1 ? "/signup" : `/page-${i}`,
    referrer: null,
    properties: i % 10 === 1 ? { plan: "free" } : {},
    browser: "Firefox",
    os: "Linux",
    deviceType: "desktop",
    country: "DE",
    region: "Bavaria",
    city: "Munich",
    release: "1.4.2",
    error: null,
  }));
  const beforeId = query.get("beforeId");
  const start = beforeId === null ? 0 : all.findIndex((item) => item.eventId === beforeId) + 1;
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    user: {
      userId,
      firstSeenAt: all.at(-1)?.occurredAt ?? "",
      lastSeenAt: all[0]?.occurredAt ?? "",
      events: all.length,
    },
    activity: all.slice(start, start + 100),
    hasMore: start + 100 < all.length,
  };
}

/** Three error groups: a TypeError, a regressed ReferenceError, and a resolved network error. */
export const ERROR_FINGERPRINTS = {
  typeError: "1-0123456789abcdef0123",
  referenceError: "2-0123456789abcdef0123",
  networkError: "3-0123456789abcdef0123",
} as const;

/** Resolutions the fake API starts with. */
export const fakeResolutions = (): FakeApi["resolutions"] => ({
  [ERROR_FINGERPRINTS.referenceError]: {
    resolvedAt: "2026-11-12T00:00:00.000Z",
    resolvedBy: "Test Owner",
  },
  [ERROR_FINGERPRINTS.networkError]: {
    resolvedAt: "2026-11-16T00:00:00.000Z",
    resolvedBy: "Test Owner",
  },
});

const ERROR_GROUPS: Omit<ErrorGroup, "status" | "resolvedAt" | "resolvedBy">[] = [
  {
    fingerprint: ERROR_FINGERPRINTS.typeError,
    type: "TypeError",
    message: "Cannot read properties of undefined (reading 'id')",
    occurrences: 1234,
    users: 3,
    visitors: 17,
    firstSeen: "2026-10-20T02:00:00.000Z",
    lastSeen: "2026-11-16T08:00:00.000Z",
  },
  {
    fingerprint: ERROR_FINGERPRINTS.referenceError,
    type: "ReferenceError",
    message: "process is not defined",
    occurrences: 8,
    users: 0,
    visitors: 5,
    firstSeen: "2026-11-01T02:00:00.000Z",
    lastSeen: "2026-11-15T08:00:00.000Z",
  },
  {
    fingerprint: ERROR_FINGERPRINTS.networkError,
    type: "Error",
    message: "Network request failed",
    occurrences: 2,
    users: 1,
    visitors: 2,
    firstSeen: "2026-11-11T02:00:00.000Z",
    lastSeen: "2026-11-14T08:00:00.000Z",
  },
];

/** The groups with their status from the fake API's resolutions, as the API works it out. */
function errorGroups(api: FakeApi): ErrorGroup[] {
  return ERROR_GROUPS.map((group) => {
    const resolution = api.resolutions[group.fingerprint];
    return {
      ...group,
      status:
        resolution === undefined
          ? "unresolved"
          : group.lastSeen > resolution.resolvedAt
            ? "regressed"
            : "resolved",
      resolvedAt: resolution?.resolvedAt ?? null,
      resolvedBy: resolution?.resolvedBy ?? null,
    };
  });
}

/** The error groups of the last 7 days, filtered by status as the API does. */
export function fakeErrors(query: URLSearchParams, api: FakeApi): ErrorList {
  const asked = query.get("status") ?? "unresolved";
  const status = isStatusFilter(asked) ? asked : "unresolved";
  const groups = errorGroups(api).filter(
    (group) => status === "all" || (group.status === "resolved") === (status === "resolved"),
  );
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    environments: ["production"],
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    status,
    truncated: false,
    groups,
  };
}

/** One group's detail; the TypeError has a stack, the others none. */
export function fakeError(
  fingerprint: string,
  query: URLSearchParams,
  api: FakeApi,
): ErrorDetail | Response {
  const group = errorGroups(api).find((item) => item.fingerprint === fingerprint);
  if (group === undefined) {
    return json(
      {
        error: "no_occurrences",
        message: "This error has no occurrence in the range and environment.",
      },
      404,
    );
  }
  const occurrence = {
    message: group.message,
    handled: false,
    path: "/checkout",
    userId: null,
    browser: "Chrome",
    browserVersion: "131.0",
    os: "Windows",
    deviceType: "desktop",
    country: "DE",
    release: "1.4.2",
  };
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    group,
    days: DAYS.map((day, i) => ({
      day: day.day,
      occurrences: [0, 120, 300, 90, 0, 400, 324][i] ?? 0,
    })),
    breakdowns: {
      path: [
        { value: "/checkout", occurrences: 900 },
        { value: null, occurrences: 334 },
      ],
      browser: [
        { value: "Chrome", occurrences: 1000 },
        { value: "Firefox", occurrences: 234 },
      ],
      os: [{ value: "Windows", occurrences: 1234 }],
      release: [
        { value: "1.4.2", occurrences: 1200 },
        { value: null, occurrences: 34 },
      ],
    },
    occurrences: [
      {
        ...occurrence,
        eventId: "00000000-0000-4000-8000-000000000001",
        occurredAt: group.lastSeen,
        userId: "ada",
      },
      {
        ...occurrence,
        eventId: "00000000-0000-4000-8000-000000000002",
        occurredAt: "2026-11-16T07:00:00.000Z",
        handled: true,
        browser: "Firefox",
        browserVersion: "132.0",
        os: "Linux",
        release: null,
      },
    ],
    stack:
      fingerprint === ERROR_FINGERPRINTS.typeError
        ? "TypeError: Cannot read properties of undefined (reading 'id')\n    at submit (https://example.com/assets/app.js:1:2345)\n    at onClick (https://example.com/assets/app.js:1:6789)"
        : null,
  };
}

/** Resolves or reopens a group, by the signed-in user, now. */
function changeErrorStatus(api: FakeApi, fingerprint: string, status: string): Response {
  if (status === "resolved") {
    const resolvedAt = new Date().toISOString();
    api.resolutions = {
      ...api.resolutions,
      [fingerprint]: { resolvedAt, resolvedBy: "Test Owner" },
    };
    return json({ fingerprint, resolvedAt });
  }
  const { [fingerprint]: _removed, ...others } = api.resolutions;
  api.resolutions = others;
  return json({ fingerprint, resolvedAt: null });
}

function removeProject(api: FakeApi, id: string): Response {
  api.projects = api.projects.filter((project) => project.id !== id);
  return new Response(null, { status: 204 });
}

/**
 * A list of 120 rows, most visitors first, searched and paged as the API
 * does: pages are /page-1 … /page-120, other lists name-1 … name-120.
 */
export function fakeList(query: URLSearchParams) {
  const report = query.get("report") ?? "pages";
  const search = (query.get("search") ?? "").toLowerCase();
  const offset = Number(query.get("offset") ?? 0);
  const limit = Number(query.get("limit") ?? 50);
  const names = Array.from({ length: 120 }, (_, i) =>
    report === "pages" ? `/page-${i + 1}` : `${report}-${i + 1}`,
  ).filter((name) => name.toLowerCase().includes(search));
  const rows = names.slice(offset, offset + limit).map((name, i) => {
    const visitors = 500 - offset - i;
    if (report === "pages")
      return { path: name, pageviews: visitors * 2, visitors, avgEngagedMs: null };
    if (report === "customEvents") return { name, events: visitors * 2, visitors };
    return { value: name, visitors, visits: visitors + 1, bounceRate: 0.5 };
  });
  return { rows, hasMore: offset + limit < names.length };
}

export const ORGANIZATION: Organization = {
  id: "99999999-9999-4999-8999-999999999999",
  name: "Acme Inc",
  timeZone: "Asia/Singapore",
  role: "owner",
  createdAt: "2026-10-01T00:00:00.000Z",
};

export const PROJECT: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: ORGANIZATION.id,
  name: "Main site",
  publicKey: "pk_test",
  allowedHostnames: ["example.com"],
  createdAt: "2026-10-01T00:00:00.000Z",
  lastEventAt: "2026-11-16T09:00:00.000Z",
  retentionDays: null,
  secretKey: "sk_00000000000000000000000000000001",
  requireSignedUserIds: false,
  ignoreDataCenters: true,
};

export const OTHER_PROJECT: Project = {
  ...PROJECT,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Docs",
  publicKey: "pk_docs",
  secretKey: "sk_00000000000000000000000000000002",
};

const DAYS: DayPoint[] = [
  { day: "2026-11-10", visitors: 120, visits: 131, pageviews: 290 },
  { day: "2026-11-11", visitors: 138, visits: 150, pageviews: 333 },
  { day: "2026-11-12", visitors: 96, visits: 101, pageviews: 210 },
  { day: "2026-11-13", visitors: 129, visits: 140, pageviews: 301 },
  { day: "2026-11-14", visitors: 109, visits: 118, pageviews: 278 },
  { day: "2026-11-15", visitors: 103, visits: 110, pageviews: 239 },
  { day: "2026-11-16", visitors: 70, visits: 74, pageviews: 169 },
];

const row = (value: string | null, visitors: number, visits: number): BreakdownRow => ({
  value,
  visitors,
  visits,
  bounceRate: 0.4,
});

/** A week of numbers for one project; change parts with `overrides`. */
export function analyticsFixture(overrides: Partial<Analytics> = {}): Analytics {
  return {
    timeZone: "Asia/Singapore",
    environment: "production",
    environments: ["production"],
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    summary: {
      visitors: 765,
      visits: 824,
      pageviews: 1820,
      viewsPerVisit: 2.21,
      bounceRate: 0.24,
      avgDurationMs: 263_000,
      avgEngagedMs: 110_000,
    },
    days: DAYS,
    pages: [
      { path: "/", pageviews: 420, visitors: 322, avgEngagedMs: 30_000 },
      { path: "/pricing", pageviews: 260, visitors: 201, avgEngagedMs: 45_000 },
    ],
    breakdowns: {
      source: [row("Direct / none", 300, 320), row("google.com", 145, 150)],
      utmCampaign: [row(null, 700, 760), row("launch", 65, 64)],
      entryPage: [row("/pricing", 210, 220), row("/", 190, 200)],
      exitPage: [row("/signup", 150, 160)],
      country: [row("DE", 155, 160), row(null, 125, 130), row("SG", 90, 95)],
      region: [row("Bavaria", 80, 85)],
      city: [row("Munich", 60, 62)],
      deviceType: [row("desktop", 269, 290), row("mobile", 242, 250)],
      browser: [row("Firefox", 130, 140)],
      os: [row("macOS", 200, 210)],
      release: [row("1.4.2", 500, 540), row(null, 265, 284)],
    },
    customEvents: [{ name: "signup", events: 140, visitors: 127 }],
    // The same week before, up to 15:00 on its last day (07:00 UTC).
    previous: {
      firstDay: "2026-11-03",
      lastDay: "2026-11-09",
      until: "2026-11-09T07:00:00.000Z",
      summary: {
        visitors: 683,
        visits: 824,
        pageviews: 2000,
        viewsPerVisit: 2.43,
        bounceRate: 0.3,
        avgDurationMs: 240_000,
        avgEngagedMs: null,
      },
    },
    ...overrides,
  };
}

/** The same days and lists with nothing in them, as for a period without events. */
export function emptyAnalytics(): Analytics {
  const fixture = analyticsFixture();
  const empty = {
    visitors: 0,
    visits: 0,
    pageviews: 0,
    viewsPerVisit: null,
    bounceRate: null,
    avgDurationMs: null,
    avgEngagedMs: null,
  };
  return {
    ...fixture,
    summary: empty,
    days: fixture.days.map((day) => ({ ...day, visitors: 0, visits: 0, pageviews: 0 })),
    pages: [],
    breakdowns: {
      source: [],
      utmCampaign: [],
      entryPage: [],
      exitPage: [],
      country: [],
      region: [],
      city: [],
      deviceType: [],
      browser: [],
      os: [],
      release: [],
    },
    customEvents: [],
    previous: { ...fixture.previous, summary: empty },
  };
}

/** A week of Web Vitals: LCP good, INP needing improvement, CLS poor; change parts with `overrides`. */
export function speedFixture(overrides: Partial<Speed> = {}): Speed {
  return {
    timeZone: "Asia/Singapore",
    environment: "production",
    environments: ["production"],
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    device: null,
    thresholds: {
      lcp: [2500, 4000],
      inp: [200, 500],
      cls: [0.1, 0.25],
      fcp: [1800, 3000],
      ttfb: [800, 1800],
    },
    loads: 400,
    metrics: {
      lcp: { p75: 2300, count: 380, good: 304, needsImprovement: 57, poor: 19 },
      inp: { p75: 240, count: 150, good: 90, needsImprovement: 45, poor: 15 },
      cls: { p75: 0.31, count: 400, good: 200, needsImprovement: 100, poor: 100 },
      fcp: { p75: 1200, count: 400, good: 360, needsImprovement: 30, poor: 10 },
      ttfb: { p75: 950, count: 400, good: 200, needsImprovement: 150, poor: 50 },
    },
    devices: [
      { deviceType: "desktop", loads: 250, lcp: 1800, inp: 120, cls: 0.05 },
      { deviceType: "mobile", loads: 140, lcp: 4600, inp: 520, cls: 0.3 },
      { deviceType: null, loads: 10, lcp: null, inp: null, cls: 0 },
    ],
    pages: [
      { path: "/", loads: 200, lcp: 2100, inp: 180, cls: 0.08 },
      { path: "/pricing", loads: 120, lcp: 3800, inp: null, cls: 0.12 },
    ],
    days: [
      { day: "2026-11-10", loads: 50, lcp: 2200, inp: 230, cls: 0.3 },
      { day: "2026-11-11", loads: 60, lcp: 2400, inp: 250, cls: 0.31 },
      { day: "2026-11-12", loads: 0, lcp: null, inp: null, cls: null },
      { day: "2026-11-13", loads: 70, lcp: 2100, inp: 220, cls: 0.29 },
      { day: "2026-11-14", loads: 80, lcp: 2500, inp: 260, cls: 0.33 },
      { day: "2026-11-15", loads: 75, lcp: 2300, inp: 240, cls: 0.3 },
      { day: "2026-11-16", loads: 65, lcp: 2350, inp: 235, cls: 0.32 },
    ],
    ...overrides,
  };
}

/** The same week with no page load measured. */
export function emptySpeed(): Speed {
  const fixture = speedFixture();
  const none = { p75: null, count: 0, good: 0, needsImprovement: 0, poor: 0 };
  return {
    ...fixture,
    loads: 0,
    metrics: { lcp: none, inp: none, cls: none, fcp: none, ttfb: none },
    devices: [],
    pages: [],
    days: fixture.days.map((day) => ({ day: day.day, loads: 0, lcp: null, inp: null, cls: null })),
  };
}

/** speedFixture, answering for the environment and device asked for. */
export function fakeSpeed(query: URLSearchParams): Speed {
  return speedFixture({
    environment: query.get("environment") ?? "production",
    device: query.get("device"),
  });
}

const WEEK = {
  timeZone: "Asia/Singapore",
  firstDay: "2026-11-10",
  lastDay: "2026-11-16",
} as const;

/** Three product events of a week; change parts with `overrides`. */
export function productEventsFixture(overrides: Partial<ProductEvents> = {}): ProductEvents {
  return {
    ...WEEK,
    environment: "production",
    environments: ["production"],
    events: [
      { name: "signup", events: 140, visitors: 127, users: 40 },
      { name: "purchase", events: 60, visitors: 50, users: 30 },
      { name: "invite_sent", events: 12, visitors: 0, users: 9 },
    ],
    ...overrides,
  };
}

export function fakeProductEvents(query: URLSearchParams): ProductEvents {
  return productEventsFixture({ environment: query.get("environment") ?? "production" });
}

type PropertyValue = string | number | boolean;

/**
 * 140 signups over the week, each with a plan (80 team, 60 free), a number
 * of seats (3 or 5), and whether it came from an invite.
 */
const SIGNUPS: { day: string; properties: Record<string, PropertyValue> }[] = Array.from(
  { length: 140 },
  (_, i) => ({
    day: `2026-11-${String(10 + (i % 7))}`,
    properties: {
      plan: i < 80 ? "team" : "free",
      seats: i % 2 === 0 ? 3 : 5,
      invited: i % 4 === 0,
    },
  }),
);

/** As the API compares a property: a string as it is, anything else as JSON writes it. */
const asText = (value: PropertyValue) =>
  typeof value === "string" ? value : JSON.stringify(value);

/** One event's detail, filtered as the API filters (signup has events; any other name, zeros). */
export function fakeProductEvent(name: string, query: URLSearchParams): ProductEventDetail {
  const filters = [...query.entries()]
    .filter(([param]) => param.startsWith("p."))
    .map(([param, value]) => ({ key: param.slice(2), value }));
  const events = (name === "signup" ? SIGNUPS : []).filter((event) =>
    filters.every((filter) => {
      const value = event.properties[filter.key];
      return value !== undefined && asText(value) === filter.value;
    }),
  );
  const names = events.length === 0 ? [] : ["plan", "seats", "invited"];
  return {
    ...WEEK,
    environment: query.get("environment") ?? "production",
    name,
    filters,
    events: events.length,
    visitors: Math.round(events.length * 0.9),
    users: Math.round(events.length * 0.3),
    days: DAYS.map(({ day }) => ({
      day,
      events: events.filter((event) => event.day === day).length,
    })),
    properties: names.map((property) => {
      const counts = new Map<string, number>();
      for (const event of events) {
        const value = event.properties[property];
        if (value !== undefined) counts.set(asText(value), (counts.get(asText(value)) ?? 0) + 1);
      }
      return {
        key: property,
        events: events.length,
        values: [...counts]
          .map(([value, count]) => ({ value, events: count }))
          .toSorted((a, b) => b.events - a.events || a.value.localeCompare(b.value)),
      };
    }),
  };
}

/** People reaching each step: 1,000 start, fewer at each next one. */
export const FUNNEL_REACHED = [1000, 420, 126, 50, 0];

/** A funnel of the steps asked for, refusing what the API refuses. */
export function fakeFunnel(query: URLSearchParams): Funnel | Response {
  let steps: unknown;
  try {
    steps = JSON.parse(query.get("steps") ?? "");
  } catch {
    return json({ error: "invalid_steps", message: "steps must be a JSON array." }, 400);
  }
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 5 || !steps.every(isFunnelStep)) {
    return json({ error: "invalid_steps", message: "steps must be 2 to 5 steps." }, 400);
  }
  const count = query.get("count") === "users" ? "users" : "visitors";
  const window = Number(query.get("window") ?? 86_400);
  if (count === "visitors" && window > 86_400) {
    return json(
      { error: "invalid_window", message: "Visitors can be followed for a day at most." },
      400,
    );
  }
  const environment = query.get("environment") ?? "production";
  return {
    ...WEEK,
    environment,
    environments:
      environment === "production" ? ["production", "staging"] : ["production", environment],
    count,
    window,
    steps: steps.map((step, i) => ({ step, reached: FUNNEL_REACHED[i] ?? 0 })),
  };
}

/** Four weekly cohorts up to the current week (16 Nov 2026), which is not over. */
export function retentionFixture(overrides: Partial<Retention> = {}): Retention {
  return {
    ...WEEK,
    environment: "production",
    environments: ["production", "staging"],
    currentWeek: "2026-11-16",
    cohorts: [
      { week: "2026-10-26", users: 40, retained: [40, 20, 12, 10] },
      { week: "2026-11-02", users: 25, retained: [25, 10, 0] },
      { week: "2026-11-09", users: 10, retained: [10, 4] },
      { week: "2026-11-16", users: 8, retained: [8] },
    ],
    ...overrides,
  };
}

export function fakeRetention(query: URLSearchParams): Retention {
  const environment = query.get("environment") ?? "production";
  return retentionFixture({
    environment,
    environments:
      environment === "production" ? ["production", "staging"] : ["production", environment],
  });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SESSION = {
  session: {
    id: "session-1",
    userId: "user-1",
    expiresAt: "2026-12-16T00:00:00.000Z",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    token: "fake",
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: "user-1",
    name: "Test Owner",
    email: "owner@example.com",
    emailVerified: false,
    image: null,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  },
};

function requestUrl(input: RequestInfo | URL): URL {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(href, window.location.origin);
}

let active: FakeApi | undefined;

function createProject(api: FakeApi, body: unknown): Response {
  const input = typeof body === "object" && body !== null ? body : {};
  const name = "name" in input && typeof input.name === "string" ? input.name : "";
  const project: Project = {
    ...PROJECT,
    id: crypto.randomUUID(),
    name,
    publicKey: "pk_new",
    lastEventAt: null,
  };
  api.projects = [...api.projects, project];
  return json({ project }, 201);
}

async function answer(api: FakeApi, url: URL, init: RequestInit | undefined): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/auth/get-session") {
    return json(api.signedIn ? SESSION : null);
  }
  if (path === "/api/auth/sign-out") {
    api.signedIn = false;
    return json({ success: true });
  }
  if (path === "/api/auth/sign-in/email") {
    api.signedIn = true;
    return json({ redirect: false, token: "fake", user: SESSION.user });
  }
  if (path === "/api/health") {
    return json({ status: "ok" });
  }
  // As the API: everything else needs a session (sign-in and setup are above or public).
  if (!api.signedIn && !path.startsWith("/api/auth/") && path !== "/api/setup") {
    return json({ error: "unauthorized", message: "Sign in to continue." }, 401);
  }
  if (path === "/api/organizations") {
    return json({ organizations: api.organizations });
  }
  const organization = /^\/api\/organizations\/([^/]+)$/.exec(path);
  const ownOrganization = api.organizations.find((item) => item.id === organization?.[1]);
  if (ownOrganization !== undefined && init?.method === "PATCH") {
    if (ownOrganization.role !== "owner") {
      return json(
        { error: "forbidden", message: "Only the organization's owner can change its settings." },
        403,
      );
    }
    const changes: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    const updated = { ...ownOrganization, ...(typeof changes === "object" ? changes : {}) };
    api.organizations = api.organizations.map((item) =>
      item.id === ownOrganization.id ? updated : item,
    );
    return json({ organization: updated });
  }
  if (path === "/api/projects" && init?.method === "POST") {
    return createProject(api, JSON.parse(typeof init.body === "string" ? init.body : "null"));
  }
  if (path === "/api/projects") {
    return json({ projects: api.projects });
  }
  if (/^\/api\/projects\/[^/]+\/users$/.test(path)) {
    const result = api.users(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/events$/.test(path)) {
    const result = api.productEvents(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  const productEventPath = /^\/api\/projects\/[^/]+\/events\/([^/]+)$/.exec(path);
  if (productEventPath?.[1] !== undefined) {
    const result = api.productEvent(decodeURIComponent(productEventPath[1]), url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/funnel$/.test(path)) {
    const result = api.funnel(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/retention$/.test(path)) {
    const result = api.retention(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/speed$/.test(path)) {
    const result = api.speed(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/errors$/.test(path)) {
    const result = api.errors(url.searchParams, api);
    return result instanceof Response ? result : json(result);
  }
  const errorPath = /^\/api\/projects\/[^/]+\/errors\/([^/]+)$/.exec(path);
  if (errorPath?.[1] !== undefined && init?.method === "PATCH") {
    const body: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    const status =
      typeof body === "object" && body !== null && "status" in body ? String(body.status) : "";
    return api.setErrorStatus(api, decodeURIComponent(errorPath[1]), status);
  }
  if (errorPath?.[1] !== undefined) {
    const result = api.error(decodeURIComponent(errorPath[1]), url.searchParams, api);
    return result instanceof Response ? result : json(result);
  }
  const userPath = /^\/api\/projects\/[^/]+\/users\/([^/]+)$/.exec(path);
  if (userPath?.[1] !== undefined) {
    const result = api.user(decodeURIComponent(userPath[1]), url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/analytics\/list$/.test(path)) {
    const result = api.list(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  const analytics = /^\/api\/projects\/([^/]+)\/analytics$/.exec(path);
  if (analytics?.[1] !== undefined) {
    const result = await api.analytics(
      analytics[1],
      url.searchParams.get("period"),
      url.searchParams,
    );
    return result instanceof Response ? result : json(result);
  }
  const secretFor = /^\/api\/projects\/([^/]+)\/secret-key$/.exec(path);
  const secreted = api.projects.find((item) => item.id === secretFor?.[1]);
  if (secreted !== undefined && init?.method === "POST") {
    const replaced = { ...secreted, secretKey: "sk_replaced" };
    api.projects = api.projects.map((item) => (item.id === secreted.id ? replaced : item));
    return json({ project: replaced });
  }
  const keyFor = /^\/api\/projects\/([^/]+)\/public-key$/.exec(path);
  const keyed = api.projects.find((item) => item.id === keyFor?.[1]);
  if (keyed !== undefined && init?.method === "POST") {
    const replaced = { ...keyed, publicKey: "pk_replaced" };
    api.projects = api.projects.map((item) => (item.id === keyed.id ? replaced : item));
    return json({ project: replaced });
  }
  const project = /^\/api\/projects\/([^/]+)$/.exec(path);
  const found = api.projects.find((item) => item.id === project?.[1]);
  if (found !== undefined && init?.method === "DELETE") {
    return api.deleteProject(api, found.id);
  }
  if (found !== undefined && init?.method === "PATCH") {
    const changes: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    const updated = { ...found, ...(typeof changes === "object" ? changes : {}) };
    api.projects = api.projects.map((item) => (item.id === found.id ? updated : item));
    return json({ project: updated });
  }
  if (found !== undefined) {
    return json({ project: found });
  }
  return json({ error: "not_found", message: `No fake answer for ${path}` }, 404);
}

/**
 * The fetch the dashboard sees in browser tests (set in setup.ts, before the
 * app loads: the sign-in client keeps the fetch it finds at start-up). It
 * answers from the current test's fake API; between tests, the API is down.
 */
export async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  if (active === undefined) {
    return json({ message: "No fake API in this test." }, 503);
  }
  active.requests.push(url.pathname + url.search);
  if (init?.method !== undefined && init.method !== "GET" && typeof init.body === "string") {
    active.bodies.push({ method: init.method, path: url.pathname, body: JSON.parse(init.body) });
  }
  return answer(active, url, init);
}

/** Sets up the fake API for the current test; removeFakeApi() takes it down. */
export function installFakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  active = {
    signedIn: true,
    organizations: [ORGANIZATION],
    projects: [PROJECT],
    analytics: () => analyticsFixture(),
    list: fakeList,
    users: fakeUsers,
    user: fakeUser,
    errors: fakeErrors,
    error: fakeError,
    setErrorStatus: changeErrorStatus,
    speed: fakeSpeed,
    productEvents: fakeProductEvents,
    productEvent: fakeProductEvent,
    funnel: fakeFunnel,
    retention: fakeRetention,
    resolutions: fakeResolutions(),
    deleteProject: removeProject,
    requests: [],
    bodies: [],
    ...overrides,
  };
  return active;
}

export function removeFakeApi() {
  active = undefined;
}

/** A promise the test resolves when it chooses, to hold a response back. */
const noop = () => undefined;

export function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
