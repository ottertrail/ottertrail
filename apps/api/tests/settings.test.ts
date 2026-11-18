import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  postgresKnowsTimeZone,
  readInstanceSettings,
  SETTINGS_CACHE_MS,
  updateInstanceSettings,
} from "../src/settings/settings.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { createTestDatabase, migrateTestDatabase } from "./helpers/test-database.ts";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const NOT_FOUND = { error: "not_found", message: "No project has this ID." };
const UNAUTHORIZED = { error: "unauthorized", message: "Sign in to continue." };
const SOME_FUNNEL = {
  name: "Some funnel",
  steps: [
    { type: "page", path: "/" },
    { type: "event", name: "signup" },
  ],
  count: "visitors",
  window: 3600,
  updatedAt: "2026-11-17T12:00:00.000Z",
};

/** Every route on one project: the access check must guard each of them. */
function projectRoutes(id: string): [string, string, object?][] {
  return [
    ["GET", `/api/projects/${id}`],
    ["PATCH", `/api/projects/${id}`, { name: "Renamed" }],
    ["DELETE", `/api/projects/${id}`, { confirmName: "Some site" }],
    ["POST", `/api/projects/${id}/public-key`],
    ["POST", `/api/projects/${id}/secret-key`],
    ["GET", `/api/projects/${id}/analytics?period=7d`],
    ["GET", `/api/projects/${id}/analytics/list?report=pages&period=7d`],
    ["GET", `/api/projects/${id}/users`],
    ["GET", `/api/projects/${id}/users/user-42`],
    ["GET", `/api/projects/${id}/speed?period=7d`],
    ["GET", `/api/projects/${id}/events?period=7d`],
    ["GET", `/api/projects/${id}/events/signup?period=7d`],
    [
      "GET",
      `/api/projects/${id}/funnel?period=7d&steps=${encodeURIComponent(
        JSON.stringify([
          { type: "page", path: "/" },
          { type: "event", name: "signup" },
        ]),
      )}`,
    ],
    ["GET", `/api/projects/${id}/retention?period=30d`],
    ["GET", `/api/projects/${id}/goals`],
    ["POST", `/api/projects/${id}/goals`, { name: "A goal", step: { type: "page", path: "/" } }],
    ["DELETE", `/api/projects/${id}/goals/00000000-0000-4000-8000-000000000000`],
    ["GET", `/api/projects/${id}/funnels`],
    ["POST", `/api/projects/${id}/funnels`, SOME_FUNNEL],
    ["PUT", `/api/projects/${id}/funnels/00000000-0000-4000-8000-000000000000`, SOME_FUNNEL],
    ["DELETE", `/api/projects/${id}/funnels/00000000-0000-4000-8000-000000000000`],
    ["GET", `/api/projects/${id}/replays`],
    ["GET", `/api/projects/${id}/replays/00000000-0000-4000-8000-000000000000`],
    ["GET", `/api/projects/${id}/replays/00000000-0000-4000-8000-000000000000/player`],
    ["DELETE", `/api/projects/${id}/replays`],
    ["GET", `/api/projects/${id}/source-maps`],
    ["GET", `/api/projects/${id}/source-maps/files?release=1.4.2`],
    ["DELETE", `/api/projects/${id}/source-maps?release=1.4.2`],
    ["GET", `/api/projects/${id}/errors?period=7d`],
    ["GET", `/api/projects/${id}/errors/1-0123456789abcdef0123?period=7d`],
    ["PATCH", `/api/projects/${id}/errors/1-0123456789abcdef0123`, { status: "resolved" }],
    ["GET", `/api/projects/${id}/traces?period=7d`],
    ["GET", `/api/projects/${id}/traces/4bf92f3577b34da6a3ce929d0e0e4736`],
    [
      "GET",
      `/api/projects/${id}/traces/4bf92f3577b34da6a3ce929d0e0e4736/spans/00f067aa0ba902b7?start=1795003200000000000`,
    ],
    ["GET", `/api/projects/${id}/logs?period=7d`],
    ["GET", `/api/projects/${id}/logs/${"0".repeat(32)}?time=1795003200000000000`],
    ["GET", `/api/projects/${id}/metrics?period=7d`],
    ["GET", `/api/projects/${id}/metrics/chart?period=7d&name=http.requests&kind=counter`],
    ["GET", `/api/projects/${id}/services?period=7d`],
    ["GET", `/api/projects/${id}/hosts?period=7d`],
    ["GET", `/api/projects/${id}/hosts/charts?period=7d&host=web-1`],
    ["GET", `/api/projects/${id}/checks`],
    ["POST", `/api/projects/${id}/checks`, { url: "https://example.com/health" }],
    ["GET", `/api/projects/${id}/checks/00000000-0000-4000-8000-000000000000`],
    ["PATCH", `/api/projects/${id}/checks/00000000-0000-4000-8000-000000000000`, { paused: true }],
    ["DELETE", `/api/projects/${id}/checks/00000000-0000-4000-8000-000000000000`],
    ["GET", `/api/projects/${id}/checks/00000000-0000-4000-8000-000000000000/results?period=7d`],
    ["GET", `/api/projects/${id}/checks/00000000-0000-4000-8000-000000000000/incidents?period=7d`],
  ];
}

describe("the access check and the instance's settings", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let carol: Awaited<ReturnType<typeof signedInUser>>;
  let site: { id: string; name: string; publicKey: string };

  function request(cookie: string | undefined, method: string, url: string, payload?: object) {
    return dashboard.app.inject({
      method: method as "GET",
      url,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        origin: PUBLIC_URL,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  beforeAll(async () => {
    dashboard = await signedInDashboard({ timeZone: "Asia/Singapore" });
    carol = await signedInUser(dashboard, { name: "Carol", email: "carol@example.com" });
    site = (
      await request(dashboard.cookie, "POST", "/api/projects", {
        name: "Some site",
        allowedHostnames: ["site.example"],
      })
    ).json().project;
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  test("every route on a project that does not exist answers 404", async () => {
    const id = randomUUID();
    const answers = await Promise.all(
      projectRoutes(id).map(async ([method, url, payload]) => {
        const response = await request(dashboard.cookie, method, url, payload);
        return { method, url, status: response.statusCode, body: response.json() };
      }),
    );
    expect(answers).toEqual(
      projectRoutes(id).map(([method, url]) => ({ method, url, status: 404, body: NOT_FOUND })),
    );
  });

  test("every route on a project answers 401 without a session", async () => {
    const answers = await Promise.all(
      projectRoutes(site.id).map(async ([method, url, payload]) => {
        const response = await request(undefined, method, url, payload);
        return { method, url, status: response.statusCode, body: response.json() };
      }),
    );
    expect(answers).toEqual(
      projectRoutes(site.id).map(([method, url]) => ({
        method,
        url,
        status: 401,
        body: UNAUTHORIZED,
      })),
    );
    // And the project is untouched.
    const seen = (await request(dashboard.cookie, "GET", `/api/projects/${site.id}`)).json();
    expect(seen.project).toMatchObject({ name: "Some site", publicKey: site.publicKey });
  });

  test("every signed-in user sees and uses the instance's projects", async () => {
    for (const cookie of [dashboard.cookie, carol.cookie]) {
      const list = (await request(cookie, "GET", "/api/projects")).json();
      expect(list.projects.map((project: { name: string }) => project.name)).toEqual(["Some site"]);
      expect((await request(cookie, "GET", `/api/projects/${site.id}`)).statusCode).toBe(200);
    }
  });

  test("reads the settings setup wrote, and says who may change them", async () => {
    expect((await request(dashboard.cookie, "GET", "/api/settings")).json()).toEqual({
      settings: { name: "Ada's company", timeZone: "Asia/Singapore", canEdit: true },
    });
    expect((await request(carol.cookie, "GET", "/api/settings")).json()).toEqual({
      settings: { name: "Ada's company", timeZone: "Asia/Singapore", canEdit: false },
    });
    expect((await request(undefined, "GET", "/api/settings")).statusCode).toBe(401);
  });

  test("only the owner changes the settings", async () => {
    const byMember = await request(carol.cookie, "PATCH", "/api/settings", {
      name: "Carol's now",
    });
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json()).toMatchObject({ error: "forbidden" });

    const byOwner = await request(dashboard.cookie, "PATCH", "/api/settings", {
      name: "  Ada & Co  ",
    });
    expect(byOwner.json()).toEqual({
      settings: { name: "Ada & Co", timeZone: "Asia/Singapore", canEdit: true },
    });
    const rows = await dashboard.db.selectFrom("instance_settings").select("name").execute();
    expect(rows).toEqual([{ name: "Ada & Co" }]);
  });

  test("a change needs the dashboard's origin, and something to change", async () => {
    const elsewhere = await dashboard.app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: {
        cookie: dashboard.cookie,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "Taken" }),
    });
    expect(elsewhere.statusCode).toBe(403);
    for (const body of [{}, { name: "   " }, { name: "x".repeat(101) }, { timeZone: "" }]) {
      expect((await request(dashboard.cookie, "PATCH", "/api/settings", body)).statusCode).toBe(
        400,
      );
    }
  });

  test("refuses a fixed offset or an unknown name as a timezone", async () => {
    for (const timeZone of ["+08:00", "Mars/Olympus_Mons"]) {
      const response = await request(dashboard.cookie, "PATCH", "/api/settings", { timeZone });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_time_zone" });
    }
  });

  test("a new timezone applies at once: to reports, and to the next visitor IDs", async () => {
    const collect = () =>
      dashboard.app.inject({
        method: "POST",
        url: "/api/events",
        headers: { "content-type": "text/plain", "user-agent": CHROME },
        payload: JSON.stringify({
          v: 1,
          key: site.publicKey,
          sentAt: Date.now(),
          events: [
            {
              id: randomUUID(),
              name: "pageview",
              occurredAt: Date.now(),
              url: "https://site.example/",
            },
          ],
        }),
      });
    expect((await collect()).statusCode).toBe(202);

    const changed = await request(dashboard.cookie, "PATCH", "/api/settings", {
      timeZone: "US/Pacific",
    });
    // Old names become their current official one.
    expect(changed.json().settings).toMatchObject({ timeZone: "America/Los_Angeles" });

    expect((await collect()).statusCode).toBe(202);
    const zones = await dashboard.db
      .selectFrom("visitor_salts")
      .select("time_zone")
      .distinct()
      .orderBy("time_zone")
      .execute();
    expect(zones.map((row) => row.time_zone)).toEqual(["America/Los_Angeles", "Asia/Singapore"]);

    const report = await request(
      dashboard.cookie,
      "GET",
      `/api/projects/${site.id}/analytics?period=today`,
    );
    expect(report.json().timeZone).toBe("America/Los_Angeles");
  });
});

describe("the settings module", () => {
  test("starts with one row, which the migration made; running it again changes nothing", async () => {
    const testDb = await createTestDatabase();
    try {
      expect(await readInstanceSettings(testDb.db)).toEqual({
        name: "Ottertrail",
        timeZone: "UTC",
      });
      expect(await migrateTestDatabase(testDb, "latest")).toEqual([]);
      // A second row is refused: the instance has one set of settings.
      await expect(
        testDb.db
          .insertInto("instance_settings")
          .values({ name: "Two", time_zone: "UTC" })
          .execute(),
      ).rejects.toThrow(/instance_settings_pkey/);
    } finally {
      await testDb.destroy();
    }
  });

  test("a change to settings whose row is gone fails, rather than report a change not made", async () => {
    const testDb = await createTestDatabase();
    try {
      await testDb.db.deleteFrom("instance_settings").execute();
      await expect(updateInstanceSettings(testDb.db, { name: "Shop" })).rejects.toThrow(
        "The instance's settings row is missing",
      );
    } finally {
      await testDb.destroy();
    }
  });

  test("keeps what it read for a few seconds: another process's change shows after that", async () => {
    const testDb = await createTestDatabase();
    try {
      const start = Date.now();
      expect((await readInstanceSettings(testDb.db, start)).timeZone).toBe("UTC");
      // As if the API in another process had changed it.
      await testDb.db
        .updateTable("instance_settings")
        .set({ time_zone: "Europe/Berlin" })
        .execute();
      expect((await readInstanceSettings(testDb.db, start + 1000)).timeZone).toBe("UTC");
      expect((await readInstanceSettings(testDb.db, start + SETTINGS_CACHE_MS + 1)).timeZone).toBe(
        "Europe/Berlin",
      );
    } finally {
      await testDb.destroy();
    }
  });

  test("postgresKnowsTimeZone asks PostgreSQL, whose timezone database can differ from Node's", async () => {
    const testDb = await createTestDatabase();
    try {
      expect(await postgresKnowsTimeZone(testDb.db, "UTC")).toBe(true);
      expect(await postgresKnowsTimeZone(testDb.db, "America/Los_Angeles")).toBe(true);
      expect(await postgresKnowsTimeZone(testDb.db, "Nowhere/Nothing")).toBe(false);
    } finally {
      await testDb.destroy();
    }
  });
});
