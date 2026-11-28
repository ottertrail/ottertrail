import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { NewEvent } from "../src/collection/event-store.ts";
import { LIST_REPORTS } from "../src/reports/analytics.ts";
import { MAX_LINKS } from "../src/share/links.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * Shared links (docs/web-analytics.md, "Shared links"; docs/access.md):
 * making, listing, and revoking them, and the public routes a link opens.
 */

/** Noon on Tuesday 17 November 2026 in UTC, the instance's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
/** A signed-in user of the customer's site, whose ID must never reach a shared link. */
const SITE_USER = "site-user-4242";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherProject = "";

function pageview(visitorId: string, minutes: number, more: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: minutesAgo(minutes),
    path: "/",
    visitorId,
    client: { browser: "Firefox", browserVersion: "140", os: "Linux", deviceType: "desktop" },
    location: { country: "DE" },
    ...more,
  };
}

function manage(
  method: "GET" | "POST" | "DELETE",
  path: string,
  { cookie = dashboard.cookie, payload, project = projectId } = {} as {
    cookie?: string;
    payload?: object;
    project?: string;
  },
) {
  return dashboard.app.inject({
    method,
    url: `/api/projects/${project}/share-links${path}`,
    headers: { cookie, origin: PUBLIC_URL },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function makeLink(
  name: string,
  environment?: string,
  project = projectId,
): Promise<{ id: string; token: string }> {
  const response = await manage("POST", "", {
    project,
    payload: environment === undefined ? { name } : { name, environment },
  });
  expect(response.statusCode).toBe(201);
  const { link, url } = response.json<{ link: { id: string }; url: string }>();
  const token = new URL(url).pathname.slice("/share/".length);
  return { id: link.id, token };
}

const share = (token: string, path = "", remoteAddress = "203.0.113.10") =>
  dashboard.app.inject({ url: `/api/share/${token}${path}`, remoteAddress });

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  projectId = (
    await insertProject(dashboard.db, { name: "Shop", allowed_hostnames: ["shop.example"] })
  ).id;
  otherProject = (await insertProject(dashboard.db, { name: "Other" })).id;
  await dashboard.store(projectId, [
    pageview("1", 200, { referrer: "https://www.google.com/" }),
    pageview("1", 198, { path: "/pricing", userId: SITE_USER }),
    pageview("2", 3, { path: "/docs" }),
    // The tracker's link and page events, which the link and not found lists count.
    pageview("2", 2, {
      name: "outbound_link",
      path: "/docs",
      properties: { url: "https://partner.example/signup" },
    }),
    pageview("1", 197, {
      name: "file_download",
      path: "/pricing",
      properties: { url: "https://shop.example/prices.pdf" },
      userId: SITE_USER,
    }),
    pageview("2", 1, { name: "not_found", path: "/old-page" }),
    pageview("3", 1, {
      name: "outbound_link",
      environment: "staging",
      path: "/staging-now",
      properties: { url: "https://staging-only.example/" },
    }),
    // Staging: counted only by a link made for it.
    pageview("3", 100, { environment: "staging", path: "/staging-only" }),
    pageview("3", 2, { environment: "staging", path: "/staging-now" }),
  ]);
  await dashboard.store(otherProject, [
    pageview("9", 100, { path: "/other-project" }),
    pageview("8", 101, { path: "/other-project" }),
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("making, listing, and revoking links", () => {
  test("a new link is shown once, and only its hash is stored", async () => {
    const response = await manage("POST", "", { payload: { name: "  For the client  " } });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { link, url } = response.json();
    expect(url).toMatch(new RegExp(`^${PUBLIC_URL}/share/[\\w-]{43}$`));
    const token = new URL(url).pathname.slice("/share/".length);
    expect(link).toEqual({
      id: expect.any(String),
      name: "For the client",
      environment: "production",
      prefix: token.slice(0, 6),
      createdAt: expect.any(String),
      createdBy: { id: expect.any(String), name: "Ada Owner" },
      lastOpenedAt: null,
    });

    const row = await dashboard.db
      .selectFrom("share_links")
      .selectAll()
      .where("id", "=", link.id)
      .executeTakeFirstOrThrow();
    expect(row.token_hash.equals(createHash("sha256").update(token).digest())).toBe(true);
    // No column holds the token itself.
    for (const value of Object.values(row)) {
      expect(String(value)).not.toContain(token);
    }

    const listed = await manage("GET", "");
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(token);
    expect(listed.json().links).toEqual([link]);
    expect(listed.json().maxLinks).toBe(MAX_LINKS);

    expect((await manage("DELETE", `/${link.id}`)).statusCode).toBe(204);
    expect((await manage("GET", "")).json().links).toEqual([]);
    expect((await manage("DELETE", `/${link.id}`)).statusCode).toBe(404);
  });

  test("a link names its environment, in lower case", async () => {
    const response = await manage("POST", "", {
      payload: { name: "Staging", environment: "Staging" },
    });
    expect(response.json().link.environment).toBe("staging");
    await manage("DELETE", `/${response.json().link.id}`);
  });

  test("refuses a bad name, a bad environment, and requests from elsewhere", async () => {
    for (const payload of [
      { name: "" },
      { name: "   " },
      { name: "a".repeat(101) },
      { name: "Tab\there" },
      { name: "Ok", environment: "no spaces" },
    ]) {
      expect((await manage("POST", "", { payload })).statusCode).toBe(400);
    }
    const noOrigin = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/share-links`,
      headers: { cookie: dashboard.cookie },
      payload: { name: "Ok" },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect((await manage("GET", "")).json().links).toEqual([]);
  });

  test(`a project has at most ${MAX_LINKS} links`, async () => {
    const made = [];
    for (let index = 0; index < MAX_LINKS; index += 1) {
      made.push(await makeLink(`Link ${index}`));
    }
    const refused = await manage("POST", "", { payload: { name: "One more" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("too_many_links");
    // Another project's links are its own.
    const other = await makeLink("Other's", undefined, otherProject);
    for (const { id } of made) await manage("DELETE", `/${id}`);
    await manage("DELETE", `/${other.id}`, { project: otherProject });
  });

  test("only the owner and admins manage links, as they manage the project's keys", async () => {
    const admin = await signedInUser(dashboard, {
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
    });
    const member = await signedInUser(dashboard, {
      name: "Member",
      email: "member@example.com",
      grants: {
        projects: "all",
        areas: {
          web_analytics: "view",
          product_analytics: "manage",
          errors: "manage",
          replays: "view",
          users: "view",
          monitoring: "view",
          ai: "view",
          uptime_alerts: "manage",
        },
      },
    });
    const elsewhere = await signedInUser(dashboard, {
      name: "Elsewhere",
      email: "elsewhere@example.com",
      grants: { projects: [otherProject], areas: { web_analytics: "view" } },
    });

    const made = await manage("POST", "", {
      cookie: admin.cookie,
      payload: { name: "By the admin" },
    });
    expect(made.statusCode).toBe(201);
    const { id } = made.json().link;
    expect(made.json().link.createdBy.name).toBe("Admin");
    expect((await manage("GET", "", { cookie: admin.cookie })).statusCode).toBe(200);

    for (const cookie of [member.cookie]) {
      expect((await manage("GET", "", { cookie })).statusCode).toBe(403);
      expect((await manage("POST", "", { cookie, payload: { name: "No" } })).statusCode).toBe(403);
      expect((await manage("DELETE", `/${id}`, { cookie })).statusCode).toBe(403);
    }
    // A project the member is not granted answers as an unknown one.
    expect((await manage("GET", "", { cookie: elsewhere.cookie })).statusCode).toBe(404);
    expect((await manage("GET", "", { cookie: "" })).statusCode).toBe(401);

    // Removing the admin keeps the link, without its maker.
    await dashboard.db.deleteFrom("dashboard_users").where("id", "=", admin.userId).execute();
    const kept = (await manage("GET", "")).json().links;
    expect(kept).toEqual([expect.objectContaining({ id, createdBy: null })]);
    await manage("DELETE", `/${id}`);
  });
});

describe("the public routes", () => {
  let production: { id: string; token: string };
  let staging: { id: string; token: string };

  beforeAll(async () => {
    production = await makeLink("Production");
    staging = await makeLink("Staging", "staging");
  });

  afterAll(async () => {
    await manage("DELETE", `/${production.id}`);
    await manage("DELETE", `/${staging.id}`);
  });

  test("the page's frame: the project's name, the link's environment, nothing more", async () => {
    const response = await share(production.token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      project: { name: "Shop", iconUrl: null },
      environment: "production",
      timeZone: "UTC",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    const row = await dashboard.db
      .selectFrom("share_links")
      .select("last_opened_at")
      .where("id", "=", production.id)
      .executeTakeFirstOrThrow();
    expect(row.last_opened_at?.toISOString()).toBe(NOW.toISOString());
    const listed = (await manage("GET", "")).json().links;
    expect(listed[0].lastOpenedAt).toBe(NOW.toISOString());
  });

  test("the reports count the link's project and environment only", async () => {
    const answer = (await share(production.token, "/analytics?period=today")).json();
    expect(answer.environment).toBe("production");
    // Never the names of the project's other environments.
    expect(answer.environments).toEqual(["production"]);
    expect(answer.summary.visitors).toBe(2);
    expect(answer.pages.map((row: { path: string }) => row.path).toSorted()).toEqual([
      "/",
      "/docs",
      "/pricing",
    ]);

    const onStaging = (await share(staging.token, "/analytics?period=today")).json();
    expect(onStaging.environment).toBe("staging");
    expect(onStaging.environments).toEqual(["staging"]);
    expect(onStaging.pages.map((row: { path: string }) => row.path).toSorted()).toEqual([
      "/staging-now",
      "/staging-only",
    ]);

    const list = (await share(staging.token, "/analytics/list?report=pages&period=today")).json();
    expect(list.rows.map((row: { path: string }) => row.path).toSorted()).toEqual([
      "/staging-now",
      "/staging-only",
    ]);

    const now = (await share(staging.token, "/analytics/now")).json();
    expect(now.environment).toBe("staging");
    expect(now.pages).toEqual([{ path: "/staging-now", visitors: 1, pageviews: 1 }]);
  });

  test("the link and not found lists show as on the dashboard, in the link's environment", async () => {
    const lists = ["outboundLinks", "fileDownloads", "notFoundPages"] as const;
    const shared = (await share(production.token, "/analytics?period=today")).json();
    const dashboardPage = (
      await dashboard.app.inject({
        url: `/api/projects/${projectId}/analytics?period=today`,
        headers: { cookie: dashboard.cookie },
      })
    ).json();
    for (const list of lists) {
      expect(shared[list]).toEqual(dashboardPage[list]);
      const full = (
        await share(production.token, `/analytics/list?report=${list}&period=today`)
      ).json();
      expect(full.rows).toEqual(dashboardPage[list]);
    }
    expect(shared.outboundLinks).toEqual([
      { value: "https://partner.example/signup", visitors: 1, events: 1 },
    ]);
    expect(shared.fileDownloads).toEqual([
      { value: "https://shop.example/prices.pdf", visitors: 1, events: 1 },
    ]);
    expect(shared.notFoundPages).toEqual([{ value: "/old-page", visitors: 1, events: 1 }]);
    const onStaging = (await share(staging.token, "/analytics?period=today")).json();
    expect(onStaging.outboundLinks).toEqual([
      { value: "https://staging-only.example/", visitors: 1, events: 1 },
    ]);
    expect(onStaging.fileDownloads).toEqual([]);
  });

  test("a request cannot name another project or environment", async () => {
    for (const path of [
      "/analytics?period=today&environment=staging",
      "/analytics?period=today&env=staging",
      `/analytics?period=today&id=${otherProject}`,
      `/analytics?period=today&projectId=${otherProject}`,
      "/analytics/list?report=pages&period=today&environment=staging",
      "/analytics/now?environment=staging",
      `/analytics/now?projectId=${otherProject}`,
      `?projectId=${otherProject}`,
    ]) {
      const response = await share(production.token, path);
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("/staging");
      expect(response.body).not.toContain("/other-project");
    }
    // Another project's route, with the link's token in place of a session, is refused.
    const asProject = await dashboard.app.inject({
      url: `/api/projects/${otherProject}/analytics?period=today`,
      headers: { authorization: `Bearer ${production.token}` },
    });
    expect(asProject.statusCode).toBe(401);
  });

  test("an unknown, malformed, and revoked token answer the same 404", async () => {
    const revoked = await makeLink("Soon gone");
    expect((await share(revoked.token, "/analytics?period=today")).statusCode).toBe(200);
    await manage("DELETE", `/${revoked.id}`);

    const answers = [];
    for (const token of [
      revoked.token,
      `${revoked.token.slice(0, -1)}${revoked.token.endsWith("A") ? "B" : "A"}`,
      "short",
      "x".repeat(200),
      // The shape of a token, but none.
      "a".repeat(43),
    ]) {
      for (const path of [
        "",
        "/analytics?period=today",
        "/analytics/list?report=pages&period=today",
        "/analytics/now",
        "/icon",
      ]) {
        const response = await share(token, path, "198.51.100.7");
        answers.push({ status: response.statusCode, body: response.body });
      }
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]?.status).toBe(404);
  });

  test("no answer holds a user ID, a visitor, or a replay", async () => {
    const paths = [
      "",
      "/analytics?period=today",
      "/analytics/now",
      ...LIST_REPORTS.map((report) => `/analytics/list?report=${report}&period=today`),
    ];
    for (const path of paths) {
      const response = await share(production.token, path);
      expect(response.statusCode).toBe(200);
      const body = response.body;
      expect(body).not.toContain(SITE_USER);
      expect(body).not.toMatch(/"(userId|user|users|visitorId|replay|replays|replayId)"/u);
    }
  });

  test("a saved goal and a custom event filter as on the dashboard", async () => {
    const goal = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/goals`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
      payload: { name: "Pricing", step: { type: "page", path: "/pricing" } },
    });
    const goalId = goal.json().goal.id;
    const answer = (await share(production.token, `/analytics?period=today&goal=${goalId}`)).json();
    expect(answer.goal).toMatchObject({ id: goalId, name: "Pricing", converted: 1 });
    expect(answer.goals).toEqual([expect.objectContaining({ id: goalId, visitors: 1 })]);

    // Another project's goal is unknown here.
    const other = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${otherProject}/goals`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
      payload: { name: "Other", step: { type: "page", path: "/other-project" } },
    });
    const refused = await share(
      production.token,
      `/analytics?period=today&goal=${other.json().goal.id}`,
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("unknown_goal");
  });
});

describe("limits", () => {
  let limited: Awaited<ReturnType<typeof signedInDashboard>>;
  let token = "";
  let project = "";

  beforeAll(async () => {
    limited = await signedInDashboard({
      now: () => NOW,
      shareLinks: {
        ipLimit: { capacity: 3, refillPerSecond: 0.001 },
        linkLimit: { capacity: 5, refillPerSecond: 0.001 },
      },
    });
    project = (await insertProject(limited.db, { name: "Limited" })).id;
    const made = await limited.app.inject({
      method: "POST",
      url: `/api/projects/${project}/share-links`,
      headers: { cookie: limited.cookie, origin: PUBLIC_URL },
      payload: { name: "Limited" },
    });
    token = new URL(made.json().url).pathname.slice("/share/".length);
  });

  afterAll(async () => {
    await limited?.close();
  });

  const from = (remoteAddress: string, path = "") =>
    limited.app.inject({ url: `/api/share/${path === "" ? token : path}`, remoteAddress });

  test("per client address, unknown tokens included, then per link", async () => {
    expect((await from("192.0.2.1")).statusCode).toBe(200);
    expect((await from("192.0.2.1", "a".repeat(43))).statusCode).toBe(404);
    expect((await from("192.0.2.1")).statusCode).toBe(200);
    const refused = await from("192.0.2.1");
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // An IPv6 address counts by its /64.
    expect((await from("2001:db8::1")).statusCode).toBe(200);
    expect((await from("2001:db8::2")).statusCode).toBe(200);
    expect((await from("2001:db8::3")).statusCode).toBe(200);
    // The link's own limit (5) is reached from every address together.
    expect((await from("192.0.2.50")).statusCode).toBe(429);
    // An unknown token is not limited by the link's.
    expect((await from("192.0.2.51", "b".repeat(43))).statusCode).toBe(404);
  });
});
