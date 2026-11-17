import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import { isTrustedOrigin } from "../src/auth/origin.ts";
import { parseHostname } from "../src/projects/projects.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

describe("parseHostname", () => {
  test.each([
    ["example.com", "example.com"],
    ["  Example.COM ", "example.com"],
    ["www.example.com", "www.example.com"],
    ["example.com.", "example.com"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    // Browsers send internationalized names in their ASCII form.
    ["bücher.example", "xn--bcher-kva.example"],
  ])("stores %j as %j", (raw, stored) => {
    expect(parseHostname(raw)).toBe(stored);
  });

  test.each([
    "",
    "https://example.com",
    "example.com/pricing",
    "example.com:8080",
    "*.example.com",
    "user@example.com",
    "exa mple.com",
  ])("refuses %j", (raw) => {
    expect(parseHostname(raw)).toBeNull();
  });
});

describe("isTrustedOrigin", () => {
  const trusted = ["https://analytics.example.com", "http://localhost:*"];
  test.each([
    ["https://analytics.example.com", true],
    ["http://localhost:5174", true],
    ["https://analytics.example.com.attacker.example", false],
    ["http://analytics.example.com", false],
    ["http://localhost", false],
    ["http://localhost.attacker.example:5174", false],
    ["https://localhost:5174", false],
    ["null", false],
    ["https://analytics.example.com/path", false],
  ])("%s is trusted: %s", (origin, expected) => {
    expect(isTrustedOrigin(origin, trusted)).toBe(expected);
  });
});

describe("project routes", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let app: Awaited<ReturnType<typeof signedInDashboard>>["app"];
  let cookie = "";

  beforeAll(async () => {
    dashboard = await signedInDashboard();
    ({ app, cookie } = dashboard);
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  function request(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
    headers: Record<string, string> = { origin: PUBLIC_URL, cookie },
  ) {
    return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  }

  test("need a signed-in user", async () => {
    const response = await request("GET", "/api/projects", undefined, {});
    expect(response.statusCode).toBe(401);
  });

  test("refuse changes that do not come from the dashboard", async () => {
    const attempts: Record<string, string>[] = [
      { cookie },
      { cookie, origin: "https://attacker.example" },
    ];
    for (const headers of attempts) {
      const response = await request("POST", "/api/projects", { name: "Evil" }, headers);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "untrusted_origin" });
    }
  });

  test("create a project with a public key and normalized hostnames", async () => {
    const response = await request("POST", "/api/projects", {
      name: "  Marketing site ",
      allowedHostnames: ["Example.com", "www.example.com", "example.com"],
    });
    expect(response.statusCode).toBe(201);
    const { project } = response.json();
    expect(project).toMatchObject({
      name: "Marketing site",
      allowedHostnames: ["example.com", "www.example.com"],
      lastEventAt: null,
    });
    expect(project.publicKey).toMatch(/^pk_[0-9a-f]{32}$/);

    const list = await request("GET", "/api/projects");
    expect(list.json().projects.map((p: { id: string }) => p.id)).toContain(project.id);
  });

  test("refuse a hostname with a scheme or a path, saying which", async () => {
    const response = await request("POST", "/api/projects", {
      name: "Docs",
      allowedHostnames: ["docs.example.com", "https://example.com/docs"],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_hostname" });
    expect(response.json().message).toContain("https://example.com/docs");
  });

  test("edit a project's name and hostnames", async () => {
    const created = (await request("POST", "/api/projects", { name: "App" })).json().project;
    const response = await request("PATCH", `/api/projects/${created.id}`, {
      name: "Web app",
      allowedHostnames: ["app.example.com"],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().project).toMatchObject({
      id: created.id,
      name: "Web app",
      allowedHostnames: ["app.example.com"],
      publicKey: created.publicKey,
    });
    const missing = await request("PATCH", `/api/projects/${randomUUID()}`, { name: "Nothing" });
    expect(missing.statusCode).toBe(404);
    const empty = await request("PATCH", `/api/projects/${created.id}`, {});
    expect(empty.statusCode).toBe(400);
  });

  test("keep events forever by default, and for a chosen number of days once set", async () => {
    const created = (await request("POST", "/api/projects", { name: "Kept" })).json().project;
    expect(created.retentionDays).toBeNull();

    const year = await request("PATCH", `/api/projects/${created.id}`, { retentionDays: 365 });
    expect(year.json().project.retentionDays).toBe(365);
    const forever = await request("PATCH", `/api/projects/${created.id}`, { retentionDays: null });
    expect(forever.json().project.retentionDays).toBeNull();

    for (const retentionDays of [29, 3651, 365.5, "a year"]) {
      const refused = await request("PATCH", `/api/projects/${created.id}`, { retentionDays });
      expect({ retentionDays, status: refused.statusCode }).toEqual({ retentionDays, status: 400 });
    }
  });

  test("report when the latest event happened", async () => {
    const created = (await request("POST", "/api/projects", { name: "Blog" })).json().project;
    const occurredAt = new Date("2026-11-16T09:30:00Z");
    await dashboard.store(created.id, [
      { eventId: randomUUID(), name: "pageview", occurredAt, path: "/" },
    ]);
    const response = await request("GET", `/api/projects/${created.id}`);
    expect(response.json().project.lastEventAt).toBe(occurredAt.toISOString());
  });

  test("accept events from a new project's site right away", async () => {
    const created = (
      await request("POST", "/api/projects", { name: "Shop", allowedHostnames: ["shop.example"] })
    ).json().project;
    const now = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "content-type": "text/plain", origin: "https://shop.example" },
      payload: JSON.stringify({
        v: 1,
        key: created.publicKey,
        sentAt: now,
        events: [
          { id: randomUUID(), name: "pageview", occurredAt: now, url: "https://shop.example/" },
        ],
      }),
    });
    expect(response.statusCode).toBe(202);
  });
});

describe("deleting a project and replacing its key", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

  beforeAll(async () => {
    dashboard = await signedInDashboard();
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  const headers = () => ({ origin: PUBLIC_URL, cookie: dashboard.cookie });

  async function create(name: string) {
    const response = await dashboard.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: headers(),
      payload: { name, allowedHostnames: ["shop.example"] },
    });
    return response.json().project as { id: string; name: string; publicKey: string };
  }

  /** One pageview from the project's site, as the tracker sends it. */
  function send(key: string) {
    const now = Date.now();
    return dashboard.app.inject({
      method: "POST",
      url: "/api/events",
      headers: {
        "content-type": "text/plain",
        origin: "https://shop.example",
        // A browser's: without one, the API counts the event as a bot's and stores nothing.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      },
      payload: JSON.stringify({
        v: 1,
        key,
        sentAt: now,
        events: [
          { id: randomUUID(), name: "pageview", occurredAt: now, url: "https://shop.example/" },
        ],
      }),
    });
  }

  const remove = (
    id: string,
    confirmName: string,
    requestHeaders: Record<string, string> = headers(),
  ) =>
    dashboard.app.inject({
      method: "DELETE",
      url: `/api/projects/${id}`,
      headers: requestHeaders,
      payload: { confirmName },
    });

  const eventCount = async (projectId: string) =>
    Number(
      (
        await dashboard.db
          .selectFrom("events")
          .select((eb) => eb.fn.countAll().as("count"))
          .where("project_id", "=", projectId)
          .executeTakeFirstOrThrow()
      ).count,
    );

  test("deleting takes the project's events with it, and only its own", async () => {
    const doomed = await create("Old shop");
    const kept = await create("New shop");
    expect((await send(doomed.publicKey)).statusCode).toBe(202);
    expect((await send(kept.publicKey)).statusCode).toBe(202);

    const response = await remove(doomed.id, " Old shop ");

    expect(response.statusCode).toBe(204);
    expect(await eventCount(doomed.id)).toBe(0);
    expect(await eventCount(kept.id)).toBe(1);
    const gone = await dashboard.app.inject({
      url: `/api/projects/${doomed.id}`,
      headers: headers(),
    });
    expect(gone.statusCode).toBe(404);
  });

  test("deleting needs the project's name, a signed-in user, and the dashboard", async () => {
    const project = await create("Careful");

    const misspelled = await remove(project.id, "careful");
    expect(misspelled.statusCode).toBe(400);
    expect(misspelled.json()).toMatchObject({ error: "name_mismatch" });
    expect((await remove(project.id, "Careful", { origin: PUBLIC_URL })).statusCode).toBe(401);
    expect(
      (
        await remove(project.id, "Careful", {
          origin: "https://attacker.example",
          cookie: dashboard.cookie,
        })
      ).statusCode,
    ).toBe(403);
    expect((await remove(randomUUID(), "Careful")).statusCode).toBe(404);
    const still = await dashboard.app.inject({
      url: `/api/projects/${project.id}`,
      headers: headers(),
    });
    expect(still.statusCode).toBe(200);
  });

  test("a deleted project's key stops working at once, not after the cache's minute", async () => {
    const project = await create("Short-lived");
    // The key is now in the collection endpoint's cache.
    expect((await send(project.publicKey)).statusCode).toBe(202);

    expect((await remove(project.id, "Short-lived")).statusCode).toBe(204);

    const after = await send(project.publicKey);
    expect(after.statusCode).toBe(403);
    expect(after.json()).toMatchObject({ error: "unknown_key" });
  });

  test("events for a project deleted elsewhere are refused as an unknown key, not as an outage", async () => {
    const project = await create("Deleted elsewhere");
    expect((await send(project.publicKey)).statusCode).toBe(202);
    // As another API process would: the cache here still holds the key.
    await dashboard.db.deleteFrom("projects").where("id", "=", project.id).execute();

    const after = await send(project.publicKey);
    expect(after.statusCode).toBe(403);
    expect(after.json()).toMatchObject({ error: "unknown_key" });
  });

  test("a replaced key stops working at once, and the new one works", async () => {
    const project = await create("Rotating");
    expect((await send(project.publicKey)).statusCode).toBe(202);

    const response = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/public-key`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    const replaced = response.json().project;
    expect(replaced.publicKey).toMatch(/^pk_[0-9a-f]{32}$/);
    expect(replaced.publicKey).not.toBe(project.publicKey);
    expect((await send(project.publicKey)).statusCode).toBe(403);
    expect((await send(replaced.publicKey)).statusCode).toBe(202);
    // The project's data stays.
    expect(await eventCount(project.id)).toBe(2);
  });

  test("replacing a key needs the dashboard and a known project", async () => {
    const project = await create("Guarded");
    const forged = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/public-key`,
      headers: { origin: "https://attacker.example", cookie: dashboard.cookie },
    });
    expect(forged.statusCode).toBe(403);
    const missing = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${randomUUID()}/public-key`,
      headers: headers(),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("tracker script", () => {
  let directory: string;
  let app: ReturnType<typeof buildApp>;
  let missing: ReturnType<typeof buildApp>;
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), "ottertrail-tracker-"));
    await writeFile(join(directory, "tracker.js"), "console.log('tracker');\n");
    app = buildApp({ db: testDb.db, trackerScriptPath: join(directory, "tracker.js") });
    missing = buildApp({ db: testDb.db, trackerScriptPath: join(directory, "not-built.js") });
  });

  afterAll(async () => {
    await app?.close();
    await missing?.close();
    await testDb?.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  test("serves the built tracker at /t.js, cacheable for an hour", async () => {
    const response = await app.inject({ url: "/t.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.body).toBe("console.log('tracker');\n");

    const etag = String(response.headers.etag);
    const again = await app.inject({ url: "/t.js", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
  });

  test("says so when the tracker has not been built", async () => {
    const response = await missing.inject({ url: "/t.js" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
