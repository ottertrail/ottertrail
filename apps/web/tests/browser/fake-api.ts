import type { Analytics, BreakdownRow, DayPoint } from "../../src/lib/analytics-api.ts";
import type { Project } from "../../src/lib/projects-api.ts";

/**
 * Stands in for the Ottertrail API: browser tests check the pages, and the
 * API has its own tests against PostgreSQL. Responses follow the API's
 * shapes; the page checks them the same way as real ones.
 */
export interface FakeApi {
  signedIn: boolean;
  projects: Project[];
  /** Answers GET /api/projects/:id/analytics. A Response stands for an error. */
  analytics: (
    projectId: string,
    period: string | null,
    query: URLSearchParams,
  ) => Analytics | Response | Promise<Analytics | Response>;
  /** Every path the page asked for, with its query, in order. */
  requests: string[];
}

export const PROJECT: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Main site",
  publicKey: "pk_test",
  allowedHostnames: ["example.com"],
  createdAt: "2026-10-01T00:00:00.000Z",
  lastEventAt: "2026-11-16T09:00:00.000Z",
};

export const OTHER_PROJECT: Project = {
  ...PROJECT,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Docs",
  publicKey: "pk_docs",
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
    },
    customEvents: [{ name: "signup", events: 140, visitors: 127 }],
    ...overrides,
  };
}

/** The same days and lists with nothing in them, as for a period without events. */
export function emptyAnalytics(): Analytics {
  const fixture = analyticsFixture();
  return {
    ...fixture,
    summary: {
      visitors: 0,
      visits: 0,
      pageviews: 0,
      viewsPerVisit: null,
      bounceRate: null,
      avgDurationMs: null,
      avgEngagedMs: null,
    },
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
    },
    customEvents: [],
  };
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
  if (path === "/api/health") {
    return json({ status: "ok" });
  }
  if (path === "/api/projects" && init?.method === "POST") {
    return createProject(api, JSON.parse(typeof init.body === "string" ? init.body : "null"));
  }
  if (path === "/api/projects") {
    return json({ projects: api.projects });
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
  const project = /^\/api\/projects\/([^/]+)$/.exec(path);
  const found = api.projects.find((item) => item.id === project?.[1]);
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
  return answer(active, url, init);
}

/** Sets up the fake API for the current test; removeFakeApi() takes it down. */
export function installFakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  active = {
    signedIn: true,
    projects: [PROJECT],
    analytics: () => analyticsFixture(),
    requests: [],
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
