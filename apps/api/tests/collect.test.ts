import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { type AppOptions, buildApp } from "../src/app.ts";
import { createDatabase } from "../src/db/database.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

/** The server's clock in these tests. */
const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const SITE = "example.com";

let testDb: TestDatabase | undefined;
let app: FastifyInstance | undefined;
const extraApps: FastifyInstance[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  app = buildApp({ db: testDb.db, collection: { now: () => NOW } });
});

afterAll(async () => {
  const apps = app === undefined ? extraApps : [app, ...extraApps];
  await Promise.all(apps.map((instance) => instance.close()));
  await testDb?.destroy();
});

function db() {
  if (testDb === undefined) throw new Error("The test database was not created");
  return testDb.db;
}

function server() {
  if (app === undefined) throw new Error("The app was not created");
  return app;
}

/** A separate app with its own limits or database, closed after all tests. */
function appWith(options: Partial<AppOptions>) {
  const instance = buildApp({ db: db(), ...options });
  extraApps.push(instance);
  return instance;
}

async function createProject(allowedHostnames = [SITE, "localhost"]) {
  return db()
    .insertInto("projects")
    .values({ name: "Test site", allowed_hostnames: allowedHostnames })
    .returning(["id", "public_key"])
    .executeTakeFirstOrThrow();
}

function pageview(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: "pageview",
    occurredAt: NOW - 1000,
    url: `https://${SITE}/lessons/closures`,
    ...overrides,
  };
}

function batch(key: string, events: unknown[] = [pageview()], overrides: object = {}) {
  return { v: 1, key, sentAt: NOW, events, ...overrides };
}

function send(
  body: unknown,
  { instance = server(), headers = {}, remoteAddress = "203.0.113.10" } = {},
) {
  return instance.inject({
    method: "POST",
    url: "/api/events",
    headers: { "content-type": "text/plain", ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
    remoteAddress,
  });
}

async function storedEvents(projectId: string) {
  return db()
    .selectFrom("events")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("occurred_at")
    .execute();
}

describe("POST /api/events", () => {
  test("stores a batch and cleans each event", async () => {
    const project = await createProject();
    // The sender's clock is two hours slow.
    const sentAt = NOW - 2 * 60 * 60 * 1000;
    const body = batch(
      project.public_key,
      [
        pageview({
          occurredAt: sentAt - 5000,
          url: `https://${SITE}/reset?token=s3cret&utm_source=newsletter&utm_campaign=launch#top`,
          referrer: "https://news.ycombinator.com/item?id=42",
          properties: { plan: "free", lesson: 3, beta: true, coupon: null },
        }),
        pageview({ occurredAt: sentAt - 1000, url: `https://${SITE}/` }),
      ],
      { sentAt },
    );

    const response = await send(body);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ stored: 2, duplicates: 0, tooOld: 0 });
    const [first, second] = await storedEvents(project.id);
    expect(first).toMatchObject({
      name: "pageview",
      path: "/reset",
      utm_source: "newsletter",
      utm_campaign: "launch",
      utm_medium: null,
      referrer: "https://news.ycombinator.com/item",
      properties: { plan: "free", lesson: 3, beta: true, coupon: null },
      // Corrected to the server's clock: 5 seconds before arrival.
      occurred_at: new Date(NOW - 5000),
    });
    expect(second).toMatchObject({ path: "/", occurred_at: new Date(NOW - 1000) });
  });

  test("accepts application/json as well as text/plain", async () => {
    const project = await createProject();
    const response = await send(batch(project.public_key), {
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(202);
  });

  test("stores a retried batch only once", async () => {
    const project = await createProject();
    const body = batch(project.public_key, [pageview(), pageview()]);

    await send(body);
    const retry = await send(body);

    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ stored: 0, duplicates: 2, tooOld: 0 });
    expect(await storedEvents(project.id)).toHaveLength(2);
  });

  test("counts events older than 24 hours as too old and stores the rest", async () => {
    const project = await createProject();
    const day = 24 * 60 * 60 * 1000;
    const response = await send(
      batch(project.public_key, [pageview({ occurredAt: NOW - day - 1 }), pageview()]),
    );
    expect(response.json()).toEqual({ stored: 1, duplicates: 0, tooOld: 1 });
  });

  test("ignores unknown fields, so newer trackers still work", async () => {
    const project = await createProject();
    const response = await send(
      batch(project.public_key, [pageview({ screen: "1920x1080" })], { library: "ottertrail-js" }),
    );
    expect(response.statusCode).toBe(202);
  });

  describe("project key and allowed hostnames", () => {
    test("rejects a key no project has", async () => {
      const response = await send(batch(`pk_${"0".repeat(32)}`));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "unknown_key" });
    });

    test("rejects a malformed key before looking anything up", async () => {
      const response = await send(batch("not-a-key"));
      expect(response.statusCode).toBe(400);
    });

    test("rejects the whole batch if any event is from another site", async () => {
      const project = await createProject();
      const response = await send(
        batch(project.public_key, [pageview(), pageview({ url: "https://evil.test/" })]),
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "hostname_not_allowed" });
      expect(await storedEvents(project.id)).toHaveLength(0);
    });

    test("accepts nothing until the project has allowed hostnames", async () => {
      const project = await createProject([]);
      const response = await send(batch(project.public_key));
      expect(response.statusCode).toBe(403);
    });

    test("lets an allowed site's browser read the response", async () => {
      const project = await createProject();
      const response = await send(batch(project.public_key), {
        headers: { origin: `https://${SITE}` },
      });
      expect(response.statusCode).toBe(202);
      expect(response.headers["access-control-allow-origin"]).toBe(`https://${SITE}`);
      expect(response.headers.vary).toBe("Origin");
    });

    test.each(["https://evil.test", "null"])("rejects requests from Origin %j", async (origin) => {
      const project = await createProject();
      const response = await send(batch(project.public_key), { headers: { origin } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "origin_not_allowed" });
      // Readable, so a misconfigured tracker stops instead of retrying.
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(await storedEvents(project.id)).toHaveLength(0);
    });
  });

  describe("validation", () => {
    const key = `pk_${"a".repeat(32)}`;
    test.each([
      ["no events", batch(key, [])],
      [
        "51 events",
        batch(
          key,
          Array.from({ length: 51 }, () => pageview()),
        ),
      ],
      ["an unknown format version", batch(key, [pageview()], { v: 2 })],
      ["no sentAt", { v: 1, key, events: [pageview()] }],
      ["an event ID that is not a UUID", batch(key, [pageview({ id: "123" })])],
      ["an empty event name", batch(key, [pageview({ name: "" })])],
      ["a control character in the name", batch(key, [pageview({ name: "page\nview" })])],
      ["a non-numeric time", batch(key, [pageview({ occurredAt: "yesterday" })])],
      ["a nested property", batch(key, [pageview({ properties: { user: { id: 1 } } })])],
      [
        "31 properties",
        batch(key, [
          pageview({
            properties: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, i])),
          }),
        ]),
      ],
    ])("rejects a batch with %s", async (_label, body) => {
      const response = await send(body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_request" });
    });

    test("rejects a body that is not JSON", async () => {
      const response = await send("{not json");
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_request" });
    });

    test("rejects a page URL that is not http(s)", async () => {
      const project = await createProject();
      const response = await send(
        batch(project.public_key, [pageview({ url: "javascript:alert(1)" })]),
      );
      expect(response.statusCode).toBe(400);
    });

    test("rejects properties larger than 8 KB", async () => {
      const project = await createProject();
      const properties = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`p${i}`, "x".repeat(500)]),
      );
      const response = await send(batch(project.public_key, [pageview({ properties })]));
      expect(response.statusCode).toBe(400);
      expect(await storedEvents(project.id)).toHaveLength(0);
    });

    test("rejects a body larger than 64 KB", async () => {
      const response = await send(
        batch(key, [pageview({ url: `https://${SITE}/${"a".repeat(70_000)}` })]),
      );
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ error: "payload_too_large" });
    });

    test("rejects other content types", async () => {
      const response = await send(batch(key), { headers: { "content-type": "text/html" } });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({ error: "unsupported_media_type" });
    });
  });

  describe("rate limits", () => {
    test("limits requests per IP address before reading the body", async () => {
      const limited = appWith({
        collection: { now: () => NOW, ipLimit: { capacity: 2, refillPerSecond: 1 } },
      });
      const project = await createProject();
      const body = batch(project.public_key);

      expect((await send(body, { instance: limited })).statusCode).toBe(202);
      expect((await send(body, { instance: limited })).statusCode).toBe(202);
      // Even an invalid body is turned away by the IP limit first.
      const third = await send("{not json", { instance: limited });
      expect(third.statusCode).toBe(429);
      expect(third.headers["retry-after"]).toBe("1");
      expect(third.json()).toMatchObject({ error: "rate_limited" });
      const fromBrowser = await send(body, {
        instance: limited,
        headers: { origin: `https://${SITE}` },
      });
      expect(fromBrowser.statusCode).toBe(429);
      // The tracker can read Retry-After only if the browser lets it see the response.
      expect(fromBrowser.headers["access-control-allow-origin"]).toBe(`https://${SITE}`);

      // Another address has its own bucket.
      const other = await send(body, { instance: limited, remoteAddress: "198.51.100.7" });
      expect(other.statusCode).toBe(202);
    });

    test("limits events per project", async () => {
      const limited = appWith({
        collection: { now: () => NOW, projectLimit: { capacity: 50, refillPerSecond: 10 } },
      });
      const project = await createProject();
      const full = Array.from({ length: 50 }, () => pageview());

      expect((await send(batch(project.public_key, full), { instance: limited })).statusCode).toBe(
        202,
      );
      const next = await send(batch(project.public_key, [pageview()]), { instance: limited });
      expect(next.statusCode).toBe(429);
      expect(next.headers["retry-after"]).toBe("1");
      expect(await storedEvents(project.id)).toHaveLength(50);
    });

    test("refuses to start with a project limit smaller than one batch", () => {
      const tooSmall = appWith({
        collection: { projectLimit: { capacity: 10, refillPerSecond: 1 } },
      });
      return expect(tooSmall.ready()).rejects.toThrow(/full batch/);
    });
  });

  describe("when PostgreSQL fails", () => {
    test("answers 503 if the project cannot be looked up", async () => {
      const unreachable = createDatabase({
        connectionString: "postgres://unused@127.0.0.1:1/unused",
      });
      const broken = appWith({ db: unreachable, collection: { now: () => NOW } });
      const response = await send(batch(`pk_${"b".repeat(32)}`), { instance: broken });
      await unreachable.destroy();

      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.json()).toMatchObject({ error: "storage_unavailable" });
    });

    test("answers 503, never 202, if the events cannot be saved", async () => {
      const separate = await createTestDatabase();
      try {
        const project = await separate.db
          .insertInto("projects")
          .values({ name: "Broken", allowed_hostnames: [SITE] })
          .returning("public_key")
          .executeTakeFirstOrThrow();
        await sql`drop table events`.execute(separate.db);
        const broken = appWith({ db: separate.db, collection: { now: () => NOW } });

        const response = await send(batch(project.public_key), { instance: broken });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ error: "storage_unavailable" });
      } finally {
        await separate.destroy();
      }
    });
  });
});
