import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { type AppOptions, buildApp } from "../src/app.ts";
import { createDatabase } from "../src/db/database.ts";
import type { Locate, Location } from "../src/enrichment/geo.ts";
import { findVisits } from "../src/visits/visits.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

/** The server's clock in these tests. */
const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const SITE = "example.com";
/** A real browser. Requests without a browser User-Agent are treated as bots. */
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
/** Stands in for a geolocation database: known test addresses only. */
const locations: Record<string, Location> = {
  "203.0.113.10": { country: "DE", region: "Bavaria", city: "Munich" },
};
const fakeLocate: Locate = (request) => locations[request.ip] ?? {};

let testDb: TestDatabase | undefined;
let app: FastifyInstance | undefined;
const extraApps: FastifyInstance[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  app = buildApp({ db: testDb.db, collection: { now: () => NOW, locate: fakeLocate } });
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
    headers: { "content-type": "text/plain", "user-agent": CHROME_MAC, ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
    remoteAddress,
  });
}

async function visitorIds(projectId: string) {
  return (await storedEvents(projectId)).map((event) => event.visitor_id);
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
    expect(response.json()).toEqual({ stored: 2, duplicates: 0, tooOld: 0, bots: 0 });
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
    expect(retry.json()).toEqual({ stored: 0, duplicates: 2, tooOld: 0, bots: 0 });
    expect(await storedEvents(project.id)).toHaveLength(2);
  });

  test("counts events older than 24 hours as too old and stores the rest", async () => {
    const project = await createProject();
    const day = 24 * 60 * 60 * 1000;
    const response = await send(
      batch(project.public_key, [pageview({ occurredAt: NOW - day - 1 }), pageview()]),
    );
    expect(response.json()).toEqual({ stored: 1, duplicates: 0, tooOld: 1, bots: 0 });
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

    test("stores properties just under 8 KB, though PostgreSQL's text form of them is larger", async () => {
      const project = await createProject();
      // 8,181 bytes as sent; PostgreSQL adds a space after each colon and comma.
      const properties = Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`key${i}`, "x".repeat(262)]),
      );
      expect(Buffer.byteLength(JSON.stringify(properties))).toBe(8181);
      const response = await send(batch(project.public_key, [pageview({ properties })]));
      expect(response.statusCode).toBe(202);
      expect(await storedEvents(project.id)).toHaveLength(1);
    });

    test.each([
      ["a NUL character in a property value", pageview({ properties: { x: "a\u0000b" } })],
      ["a NUL character in a property name", pageview({ properties: { "a\u0000b": 1 } })],
      ["an unpaired surrogate in a property value", pageview({ properties: { x: "\ud800" } })],
      ["an unpaired surrogate in the name", pageview({ name: "sign\ud800up" })],
    ])("rejects text PostgreSQL cannot store: %s", async (_label, event) => {
      const project = await createProject();
      const response = await send(batch(project.public_key, [pageview(), event]));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_request" });
      expect(await storedEvents(project.id)).toHaveLength(0);
    });

    test("drops a campaign tag that decodes to a NUL character, and keeps the event", async () => {
      const project = await createProject();
      const response = await send(
        batch(project.public_key, [
          pageview({ url: `https://${SITE}/?utm_source=%00&utm_campaign=launch` }),
        ]),
      );
      expect(response.statusCode).toBe(202);
      const [stored] = await storedEvents(project.id);
      expect(stored).toMatchObject({ utm_source: null, utm_campaign: "launch" });
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
      // The tracker can read Retry-After only if the browser lets it see the response
      // and that header: it is not one browsers show cross-site pages by default.
      expect(fromBrowser.headers["access-control-allow-origin"]).toBe(`https://${SITE}`);
      expect(fromBrowser.headers["access-control-expose-headers"]).toBe("Retry-After");

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

  describe("enrichment", () => {
    test("adds browser, OS, device, and location, and never stores the IP address", async () => {
      const project = await createProject();
      const response = await send(batch(project.public_key));
      expect(response.statusCode).toBe(202);

      const [event] = await storedEvents(project.id);
      expect(event).toMatchObject({
        browser: "Chrome",
        browser_version: "142",
        os: "macOS",
        device_type: "desktop",
        country: "DE",
        region: "Bavaria",
        city: "Munich",
      });
      // No column holds the client's address.
      expect(JSON.stringify(event)).not.toContain("203.0.113.10");
    });

    test("stores no location when the address has none, such as a private network", async () => {
      const project = await createProject();
      await send(batch(project.public_key), { remoteAddress: "192.168.0.101" });
      const [event] = await storedEvents(project.id);
      expect(event).toMatchObject({ browser: "Chrome", country: null, region: null, city: null });
    });

    test("recognizes phones and tablets", async () => {
      const project = await createProject();
      const iphone =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
      await send(batch(project.public_key), { headers: { "user-agent": iphone } });
      const [event] = await storedEvents(project.id);
      expect(event).toMatchObject({
        browser: "Safari",
        browser_version: "18",
        os: "iOS",
        device_type: "mobile",
      });
    });

    test.each([
      [
        "a search engine crawler",
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      ],
      [
        "a headless browser",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36",
      ],
      ["curl", "curl/8.7.1"],
      ["no User-Agent at all", ""],
    ])("accepts and ignores events from %s", async (_label, userAgent) => {
      const project = await createProject();
      const response = await send(batch(project.public_key, [pageview(), pageview()]), {
        headers: { "user-agent": userAgent },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ stored: 0, duplicates: 0, tooOld: 0, bots: 2 });
      expect(await storedEvents(project.id)).toHaveLength(0);
    });

    test("does not let bots use up the project's event budget", async () => {
      const limited = appWith({
        collection: { now: () => NOW, projectLimit: { capacity: 50, refillPerSecond: 0.001 } },
      });
      const project = await createProject();
      const full = Array.from({ length: 50 }, () => pageview());
      await send(batch(project.public_key, full), {
        instance: limited,
        headers: { "user-agent": "curl/8.7.1" },
      });

      const human = await send(batch(project.public_key, full), { instance: limited });
      expect(human.statusCode).toBe(202);
    });
  });

  describe("visitors", () => {
    test("gives every event a visitor ID: the same browser and address share one", async () => {
      const project = await createProject();
      await send(batch(project.public_key, [pageview(), pageview()]));
      await send(batch(project.public_key, [pageview()]));
      await send(batch(project.public_key, [pageview()]), { remoteAddress: "81.2.69.160" });
      await send(batch(project.public_key, [pageview()]), {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
        },
      });

      const ids = await visitorIds(project.id);
      expect(ids).toHaveLength(5);
      expect(ids.every((id) => id !== null)).toBe(true);
      // Three requests from one browser and address, then two other visitors.
      expect(new Set(ids).size).toBe(3);
    });

    test("starts the visitor's day at midnight in the instance's timezone", async () => {
      // The server's clock: 00:31 UTC, which is 08:31 in Singapore.
      const now = Date.parse("2026-11-17T00:31:00.000Z");
      const twoEvents = (key: string) =>
        batch(
          key,
          [
            pageview({ occurredAt: now - 61 * 60 * 1000 }), // 23:30 UTC, 07:30 Singapore
            pageview({ occurredAt: now - 60 * 1000 }), // 00:30 UTC, 08:30 Singapore
          ],
          { sentAt: now },
        );

      const singapore = appWith({ collection: { now: () => now, timeZone: "Asia/Singapore" } });
      const inSingapore = await createProject();
      await send(twoEvents(inSingapore.public_key), { instance: singapore });
      expect(new Set(await visitorIds(inSingapore.id)).size).toBe(1);

      const utc = appWith({ collection: { now: () => now, timeZone: "UTC" } });
      const inUtc = await createProject();
      await send(twoEvents(inUtc.public_key), { instance: utc });
      expect(new Set(await visitorIds(inUtc.id)).size).toBe(2);
    });
  });

  describe("engagement events", () => {
    test("stores time on page reported by the tracker", async () => {
      const project = await createProject();
      const response = await send(
        batch(project.public_key, [
          pageview({ name: "engagement", properties: { engagedMs: 42_000 } }),
        ]),
      );
      expect(response.statusCode).toBe(202);
      const [event] = await storedEvents(project.id);
      expect(event).toMatchObject({ name: "engagement", properties: { engagedMs: 42_000 } });
    });

    test.each([
      ["no engaged time", {}],
      ["a negative time", { engagedMs: -1 }],
      ["a fraction of a millisecond", { engagedMs: 1.5 }],
      ["more than 24 hours", { engagedMs: 24 * 60 * 60 * 1000 + 1 }],
      ["text instead of a number", { engagedMs: "42" }],
    ])("rejects an engagement event with %s", async (_label, properties) => {
      const project = await createProject();
      const response = await send(
        batch(project.public_key, [pageview(), pageview({ name: "engagement", properties })]),
      );
      expect(response.statusCode).toBe(400);
      expect(await storedEvents(project.id)).toHaveLength(0);
    });
  });

  describe("visits across midnight", () => {
    test("splits a visit at midnight in the instance's timezone, with no link between the days", async () => {
      let clock = Date.parse("2026-11-16T15:50:00.000Z"); // 23:50 in Singapore
      const singapore = appWith({ collection: { now: () => clock, timeZone: "Asia/Singapore" } });
      const project = await createProject();

      await send(
        batch(project.public_key, [pageview({ occurredAt: clock, url: `https://${SITE}/` })], {
          sentAt: clock,
        }),
        { instance: singapore },
      );
      clock = Date.parse("2026-11-16T16:05:00.000Z"); // 00:05 the next day
      await send(
        batch(project.public_key, [pageview({ occurredAt: clock, url: `https://${SITE}/docs` })], {
          sentAt: clock,
        }),
        { instance: singapore },
      );

      const [before, after] = await storedEvents(project.id);
      expect(after?.visitor_id).not.toBe(before?.visitor_id); // A new day, a new ID …
      expect(Object.keys(after ?? {})).not.toContain("previous_visitor_id"); // … and no link.

      const visits = await findVisits(db(), {
        projectId: project.id,
        from: new Date("2026-11-16T00:00:00Z"),
        to: new Date("2026-11-17T00:00:00Z"),
      });
      expect(visits.map((visit) => visit.entryPath)).toEqual(["/", "/docs"]);
    });
  });

  describe("logging", () => {
    test("request logs never contain the client's IP address", async () => {
      const lines: string[] = [];
      const logged = appWith({
        collection: { now: () => NOW, locate: fakeLocate },
        log: { level: "trace", stream: { write: (line) => lines.push(line) } },
      });
      const project = await createProject();

      await send(batch(project.public_key), { instance: logged, remoteAddress: "198.51.100.23" });
      await send("{not json", { instance: logged, remoteAddress: "198.51.100.23" });

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((line) => line.includes('"url":"/api/events"'))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain("198.51.100.23");
        expect(line).not.toContain("remoteAddress");
      }
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
