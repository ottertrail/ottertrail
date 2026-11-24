import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import { isTrustedOrigin } from "../src/auth/origin.ts";
import { purgeDeletedProjects } from "../src/clickhouse/delete-events.ts";
import { parseHostname } from "../src/projects/projects.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { countEvents, storedEvents } from "./helpers/events.ts";
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
  const trusted = ["https://ottertrail.example.com", "http://localhost:*"];
  test.each([
    ["https://ottertrail.example.com", true],
    ["http://localhost:5174", true],
    ["https://ottertrail.example.com.attacker.example", false],
    ["http://ottertrail.example.com", false],
    ["http://localhost", false],
    ["http://localhost.attacker.example:5174", false],
    ["https://localhost:5174", false],
    ["null", false],
    ["https://ottertrail.example.com/path", false],
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

  /** A server-side event sent with `key`. */
  const sendWith = (key: string) =>
    app.inject({
      method: "POST",
      url: "/api/server-events",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: JSON.stringify({
        v: 1,
        events: [{ id: randomUUID(), name: "paid", occurredAt: Date.now(), userId: "42" }],
      }),
    });

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

  test("give each project a secret key for its server; replacing it stops the old one at once", async () => {
    const created = (await request("POST", "/api/projects", { name: "API" })).json().project;
    expect(created.secretKey).toMatch(/^sk_[0-9a-f]{32}$/);
    expect(created.requireSignedUserIds).toBe(false);
    expect((await sendWith(created.secretKey)).statusCode).toBe(202);

    const replaced = await request("POST", `/api/projects/${created.id}/secret-key`);
    expect(replaced.statusCode).toBe(200);
    const newKey = replaced.json().project.secretKey;
    expect(newKey).not.toBe(created.secretKey);

    expect((await sendWith(created.secretKey)).statusCode).toBe(401);
    expect((await sendWith(newKey)).statusCode).toBe(202);
  });

  test("require signed user IDs, from the next event on", async () => {
    const created = (
      await request("POST", "/api/projects", { name: "Signed", allowedHostnames: ["shop.example"] })
    ).json().project;
    /** Sends an event from user 42, unsigned, and gives the user ID stored with it. */
    const browserEvent = async () => {
      const id = randomUUID();
      const response = await app.inject({
        method: "POST",
        url: "/api/events",
        headers: {
          "content-type": "text/plain",
          origin: "https://shop.example",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        },
        payload: JSON.stringify({
          v: 1,
          key: created.publicKey,
          sentAt: Date.now(),
          events: [
            {
              id,
              name: "pageview",
              occurredAt: Date.now(),
              url: "https://shop.example/",
              userId: "42",
            },
          ],
        }),
      });
      expect(response.statusCode).toBe(202);
      const stored = await storedEvents(dashboard.reader.client, created.id);
      return stored.find((event) => event.event_id === id)?.user_id;
    };
    // Read once, so collection has the project cached.
    expect(await browserEvent()).toBe("42");

    const changed = await request("PATCH", `/api/projects/${created.id}`, {
      requireSignedUserIds: true,
    });
    expect(changed.json().project.requireSignedUserIds).toBe(true);

    expect(await browserEvent()).toBeNull();
  });

  test("changing the allowed sites applies from the next event on", async () => {
    const created = (
      await request("POST", "/api/projects", { name: "Moved", allowedHostnames: ["shop.example"] })
    ).json().project;
    const browserEvent = () =>
      app.inject({
        method: "POST",
        url: "/api/events",
        headers: {
          "content-type": "text/plain",
          origin: "https://shop.example",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        },
        payload: JSON.stringify({
          v: 1,
          key: created.publicKey,
          sentAt: Date.now(),
          events: [
            {
              id: randomUUID(),
              name: "pageview",
              occurredAt: Date.now(),
              url: "https://shop.example/",
            },
          ],
        }),
      });
    // Sent once, so collection has the project cached.
    expect((await browserEvent()).statusCode).toBe(202);

    const changed = await request("PATCH", `/api/projects/${created.id}`, {
      allowedHostnames: ["store.example"],
    });
    expect(changed.statusCode).toBe(200);

    const refused = await browserEvent();
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "origin_not_allowed" });
  });

  test("ignore browsers in data centers unless turned off", async () => {
    const created = (await request("POST", "/api/projects", { name: "Cloud" })).json().project;
    expect(created.ignoreDataCenters).toBe(true);

    const changed = await request("PATCH", `/api/projects/${created.id}`, {
      ignoreDataCenters: false,
    });
    expect(changed.json().project.ignoreDataCenters).toBe(false);
    const reloaded = await request("GET", `/api/projects/${created.id}`);
    expect(reloaded.json().project.ignoreDataCenters).toBe(false);

    const refused = await request("PATCH", `/api/projects/${created.id}`, {
      ignoreDataCenters: "no",
    });
    expect(refused.statusCode).toBe(400);
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

  const eventCount = (projectId: string) => countEvents(dashboard.reader.client, projectId);

  test("deleting takes the project's events with it, and only its own", async () => {
    const doomed = await create("Old shop");
    const kept = await create("New shop");
    expect((await send(doomed.publicKey)).statusCode).toBe(202);
    expect((await send(kept.publicKey)).statusCode).toBe(202);

    const response = await remove(doomed.id, " Old shop ");

    expect(response.statusCode).toBe(204);
    // ClickHouse's events go when the worker next purges deleted projects.
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);
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

  test("events a cached key lets in after the project was deleted elsewhere are purged with it", async () => {
    const project = await create("Deleted elsewhere");
    expect((await send(project.publicKey)).statusCode).toBe(202);
    // As another API process would: the cache here still holds the key.
    await dashboard.db.deleteFrom("projects").where("id", "=", project.id).execute();

    // ClickHouse cannot check that the project still exists.
    expect((await send(project.publicKey)).statusCode).toBe(202);
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);
    expect(await eventCount(project.id)).toBe(0);
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
    await writeFile(join(directory, "v.js"), "console.log('vitals');\n");
    await writeFile(join(directory, "h.js"), "console.log('heatmaps');\n");
    app = buildApp({ db: testDb.db, trackerScriptPath: join(directory, "tracker.js") });
    missing = buildApp({
      db: testDb.db,
      trackerScriptPath: join(directory, "not-built", "tracker.js"),
    });
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

  test("serves a rebuilt script at once, even at the same size and modification time", async () => {
    const path = join(directory, "tracker.js");
    const mtime = new Date("2026-11-01T00:00:00Z");
    await utimes(path, mtime, mtime);
    const first = await app.inject({ url: "/t.js" });
    await writeFile(path, "console.log('TRACKER');\n");
    await utimes(path, mtime, mtime);
    const rebuilt = await app.inject({ url: "/t.js" });
    expect(rebuilt.body).toBe("console.log('TRACKER');\n");
    expect(rebuilt.headers.etag).not.toBe(first.headers.etag);
    await writeFile(path, "console.log('tracker');\n");
  });

  test("serves the Web Vitals script it loads, v.js, from beside it", async () => {
    const response = await app.inject({ url: "/v.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.body).toBe("console.log('vitals');\n");
  });

  test("serves the heatmap script it loads, h.js, from beside it", async () => {
    const response = await app.inject({ url: "/h.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.body).toBe("console.log('heatmaps');\n");
  });

  test("says so when the tracker has not been built", async () => {
    for (const url of ["/t.js", "/v.js", "/h.js"]) {
      const response = await missing.inject({ url });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 503 });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });
});
