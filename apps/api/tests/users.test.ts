import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { requestLogFields } from "../src/app.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
/** 200 characters, the most a user ID may have: 400 UTF-16 units. */
const LONG_ID = "😀".repeat(200);

function event(iso: string, overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date(iso),
    path: "/",
    visitorId: "1",
    ...overrides,
  };
}

beforeAll(async () => {
  dashboard = await signedInDashboard({ timeZone: "Asia/Singapore" });
  const project = await insertProject(dashboard.db, {
    name: "Users",
    allowed_hostnames: ["example.com"],
  });
  projectId = project.id;
  await dashboard.store(projectId, [
    // An anonymous visitor: never a user.
    event("2026-11-16T01:00:00Z", { visitorId: "9" }),
    // Ada, first anonymous, then signed in. Only her events with her ID count.
    event("2026-11-16T02:00:00Z", { path: "/pricing" }),
    event("2026-11-16T02:05:00Z", { path: "/signup", userId: "ada" }),
    event("2026-11-16T02:06:00Z", {
      name: "signup",
      path: "/signup",
      userId: "ada",
      properties: { plan: "free" },
      client: { browser: "Firefox", os: "Linux", deviceType: "desktop" },
      location: { country: "DE", region: "Bavaria", city: "Munich" },
      release: "1.4.2",
    }),
    event("2026-11-16T02:07:00Z", {
      name: "engagement",
      path: "/signup",
      userId: "ada",
      properties: { engagedMs: 60_000 },
    }),
    event("2026-11-17T08:00:00Z", { path: "/docs", userId: "ada", visitorId: "11" }),
    // Bob, seen once; a user ID with a slash and a space.
    event("2026-11-16T05:00:00Z", { path: "/", userId: "team b/bob", visitorId: "2" }),
    // Bob's time on that page, reported later: not something he did, so not when he was last seen.
    event("2026-11-16T05:20:00Z", {
      name: "engagement",
      userId: "team b/bob",
      visitorId: "2",
      properties: { engagedMs: 60_000 },
    }),
    // Only an engagement report: no user to list.
    event("2026-11-16T06:00:00Z", {
      name: "engagement",
      userId: "only-engaged",
      visitorId: "3",
      properties: { engagedMs: 1000 },
    }),
    // An ID as long as allowed.
    event("2026-11-16T07:00:00Z", { userId: LONG_ID, visitorId: "4" }),
    // Ada on the staging site: another environment.
    event("2026-11-16T03:00:00Z", { path: "/beta", userId: "ada", environment: "staging" }),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

function get(url: string) {
  return dashboard.app.inject({ url, headers: { cookie: dashboard.cookie } });
}

describe("GET /api/projects/:id/users", () => {
  test("needs a signed-in user", async () => {
    const response = await dashboard.app.inject({ url: `/api/projects/${projectId}/users` });
    expect(response.statusCode).toBe(401);
  });

  test("lists known users, most recently seen first, with their events", async () => {
    const response = await get(`/api/projects/${projectId}/users`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      timeZone: "Asia/Singapore",
      environment: "production",
      signedUserIdsRequired: false,
      environments: ["production", "staging"],
      users: [
        {
          userId: "ada",
          firstSeenAt: "2026-11-16T02:05:00.000Z",
          lastSeenAt: "2026-11-17T08:00:00.000Z",
          // Two pageviews and a signup; the engagement report is not an event of hers.
          events: 3,
        },
        {
          userId: LONG_ID,
          firstSeenAt: "2026-11-16T07:00:00.000Z",
          lastSeenAt: "2026-11-16T07:00:00.000Z",
          events: 1,
        },
        {
          userId: "team b/bob",
          firstSeenAt: "2026-11-16T05:00:00.000Z",
          lastSeenAt: "2026-11-16T05:00:00.000Z",
          events: 1,
        },
      ],
      hasMore: false,
    });
  });

  test("searches by ID, ignoring case, and pages through", async () => {
    const found = (await get(`/api/projects/${projectId}/users?search=BOB`)).json();
    expect(found.users.map((user: { userId: string }) => user.userId)).toEqual(["team b/bob"]);

    const first = (await get(`/api/projects/${projectId}/users?limit=2`)).json();
    expect(first).toMatchObject({ users: [{ userId: "ada" }, { userId: LONG_ID }], hasMore: true });
    const second = (await get(`/api/projects/${projectId}/users?limit=2&offset=2`)).json();
    expect(second).toMatchObject({ users: [{ userId: "team b/bob" }], hasMore: false });
    // Later pages skip the environments: the page reads them from the first.
    expect(second.environments).toEqual([]);
  });

  test("counts one environment at a time", async () => {
    const staging = (await get(`/api/projects/${projectId}/users?environment=staging`)).json();
    expect(staging).toMatchObject({
      environment: "staging",
      users: [{ userId: "ada", events: 1, firstSeenAt: "2026-11-16T03:00:00.000Z" }],
    });
  });
});

describe("GET /api/projects/:id/users/:userId", () => {
  test("shows a user and their activity, newest first, without engagement reports", async () => {
    const response = await get(`/api/projects/${projectId}/users/ada`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      timeZone: "Asia/Singapore",
      environment: "production",
      signedUserIdsRequired: false,
      user: { userId: "ada", events: 3 },
      hasMore: false,
    });
    expect(
      body.activity.map((item: { name: string; path: string }) => [item.name, item.path]),
    ).toEqual([
      ["pageview", "/docs"],
      ["signup", "/signup"],
      ["pageview", "/signup"],
    ]);
    expect(body.activity[1]).toMatchObject({
      occurredAt: "2026-11-16T02:06:00.000Z",
      properties: { plan: "free" },
      browser: "Firefox",
      os: "Linux",
      deviceType: "desktop",
      country: "DE",
      city: "Munich",
      release: "1.4.2",
    });
  });

  test("leaves out anonymous events, even in the same visit before the sign-in", async () => {
    const body = (await get(`/api/projects/${projectId}/users/ada`)).json();
    expect(body.activity.map((item: { path: string }) => item.path)).not.toContain("/pricing");
  });

  test("pages back from the last event of the page before", async () => {
    const first = (await get(`/api/projects/${projectId}/users/ada?limit=2`)).json();
    expect(first.hasMore).toBe(true);
    const last = first.activity.at(-1);
    const next = (
      await get(
        `/api/projects/${projectId}/users/ada?limit=2&before=${encodeURIComponent(last.occurredAt)}&beforeId=${last.eventId}`,
      )
    ).json();
    expect(next.activity.map((item: { path: string }) => item.path)).toEqual(["/signup"]);
    expect(next.hasMore).toBe(false);
  });

  test("finds an ID with a slash or a space, sent encoded", async () => {
    const response = await get(
      `/api/projects/${projectId}/users/${encodeURIComponent("team b/bob")}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().user.userId).toBe("team b/bob");
  });

  test("finds an ID of 200 characters", async () => {
    const response = await get(`/api/projects/${projectId}/users/${encodeURIComponent(LONG_ID)}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().user.userId).toBe(LONG_ID);
  });

  test("a user with only engagement reports is not a user to show", async () => {
    expect((await get(`/api/projects/${projectId}/users/only-engaged`)).statusCode).toBe(404);
  });

  test("answers 404 for an ID without events in the environment", async () => {
    expect((await get(`/api/projects/${projectId}/users/nobody`)).statusCode).toBe(404);
    expect(
      (
        await get(
          `/api/projects/${projectId}/users/${encodeURIComponent("team b/bob")}?environment=staging`,
        )
      ).statusCode,
    ).toBe(404);
  });

  test("refuses half a cursor, or one that is not a time", async () => {
    const id = randomUUID();
    for (const query of [
      "before=2026-11-16T02:06:00.000Z",
      `beforeId=${id}`,
      `before=yesterday&beforeId=${id}`,
      `before=2026-13-45T99:99:99Z&beforeId=${id}`,
    ]) {
      const response = await get(`/api/projects/${projectId}/users/ada?${query}`);
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
    }
  });
});

describe("signedUserIdsRequired", () => {
  test("follows the project's setting, for a member with users view too", async () => {
    const member = await signedInUser(dashboard, {
      name: "Mia",
      email: "mia@example.com",
      grants: { projects: [projectId], areas: { users: "view" } },
    });
    await dashboard.db
      .updateTable("projects")
      .set({ require_signed_user_ids: true })
      .where("id", "=", projectId)
      .execute();
    try {
      for (const url of [
        `/api/projects/${projectId}/users`,
        `/api/projects/${projectId}/users/ada`,
      ]) {
        const response = await dashboard.app.inject({ url, headers: { cookie: member.cookie } });
        expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
        expect(response.json().signedUserIdsRequired).toBe(true);
      }
    } finally {
      await dashboard.db
        .updateTable("projects")
        .set({ require_signed_user_ids: false })
        .where("id", "=", projectId)
        .execute();
    }
  });
});

describe("request logs", () => {
  test("mask user IDs, in a user's path and in a search", () => {
    expect(
      requestLogFields({
        method: "GET",
        url: "/api/projects/p1/users/ada%40example.com?environment=staging",
      }),
    ).toEqual({ method: "GET", url: "/api/projects/p1/users/…?environment=staging" });
    expect(
      requestLogFields({ method: "GET", url: "/api/projects/p1/users?search=ada&offset=50" }),
    ).toEqual({ method: "GET", url: "/api/projects/p1/users?search=…&offset=50" });
    expect(requestLogFields({ method: "GET", url: "/projects/p1/users/john.doe" }).url).toBe(
      "/projects/p1/users/…",
    );
  });
});
