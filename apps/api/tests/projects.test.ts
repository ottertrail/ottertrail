import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import { isTrustedOrigin } from "../src/auth/origin.ts";
import { storeEvents } from "../src/collection/event-store.ts";
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
  let testDb: { db: Awaited<ReturnType<typeof signedInDashboard>>["db"] };
  let cookie = "";

  beforeAll(async () => {
    dashboard = await signedInDashboard();
    ({ app, cookie } = dashboard);
    testDb = { db: dashboard.db };
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

  test("report when the latest event happened", async () => {
    const created = (await request("POST", "/api/projects", { name: "Blog" })).json().project;
    const occurredAt = new Date("2026-11-16T09:30:00Z");
    await storeEvents(testDb.db, created.id, [
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
