import { randomUUID } from "node:crypto";
import { type AddressInfo, connect } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vite-plus/test";

import { type AppOptions, buildApp } from "../src/app.ts";
import { type ClickHouseClient, createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import type { Locate, Location } from "../src/enrichment/geo.ts";
import { findVisits } from "../src/visits/visits.ts";
import { countEvents, storedEvents as storedIn } from "./helpers/events.ts";
import { insertProject, setInstanceTimeZone } from "./helpers/projects.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const SITE = "example.com";
/** A browser User-Agent is needed to avoid bot filtering. */
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
/** Stands in for a geolocation database: known test addresses only. */
const locations: Record<string, Location> = {
  "203.0.113.10": { country: "DE", region: "Bavaria", city: "Munich" },
};
const fakeLocate: Locate = (ip) => locations[ip] ?? {};

let testDb: TestDatabase | undefined;
let testClickHouse: TestClickHouse | undefined;
let app: FastifyInstance | undefined;
const extraApps: FastifyInstance[] = [];

beforeAll(async () => {
  // One after the other: if the second fails, afterAll still drops the first.
  testDb = await createTestDatabase();
  testClickHouse = await createTestClickHouse();
  app = buildApp({
    db: testDb.db,
    collection: { now: () => NOW, locate: fakeLocate, clickhouse: testClickHouse.client },
  });
});

afterAll(async () => {
  const apps = app === undefined ? extraApps : [app, ...extraApps];
  await Promise.all(apps.map((instance) => instance.close()));
  await testDb?.destroy();
  await testClickHouse?.destroy();
});

function db() {
  if (testDb === undefined) throw new Error("The test database was not created");
  return testDb.db;
}

function clickhouse() {
  if (testClickHouse === undefined) throw new Error("The test ClickHouse was not created");
  return testClickHouse.client;
}

function server() {
  if (app === undefined) throw new Error("The app was not created");
  return app;
}

/** A separate app with its own limits or database, closed after all tests; the test ClickHouse unless `collection` names another. */
function appWith(options: Partial<AppOptions>) {
  const instance = buildApp({
    db: db(),
    ...options,
    collection: { clickhouse: clickhouse(), ...options.collection },
  });
  extraApps.push(instance);
  return instance;
}

async function createProject(allowedHostnames = [SITE, "localhost"]) {
  return insertProject(db(), { name: "Test site", allowed_hostnames: allowedHostnames });
}

/** A project that may require signed user IDs. Secret keys are unique: give a fixed one once. */
async function signingProject(required: boolean, secretKey?: string) {
  return insertProject(db(), {
    name: "Signed",
    allowed_hostnames: [SITE],
    require_signed_user_ids: required,
    ...(secretKey === undefined ? {} : { secret_key: secretKey }),
  });
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

const pageviews = (count: number) => Array.from({ length: count }, () => pageview());

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

/** A project with its own location source (collection/location-headers.ts). */
async function sourceProject(values: object) {
  return insertProject(db(), { name: "Located", allowed_hostnames: [SITE], ...values });
}

/** An app whose database lookup counts its calls. */
function countingApp() {
  const calls: string[] = [];
  const instance = appWith({
    // Behind a proxy, as with Caddy (TRUST_PROXY=1).
    trustProxy: true,
    collection: {
      now: () => NOW,
      locate: (ip) => {
        calls.push(ip);
        return fakeLocate(ip);
      },
    },
  });
  return { instance, calls };
}

async function visitorIds(projectId: string) {
  return (await storedEvents(projectId)).map((event) => event.visitor_id);
}

/** The project's events in ClickHouse, each once, oldest first. */
async function storedEvents(projectId: string) {
  return storedIn(clickhouse(), projectId);
}

async function lastEventAt(projectId: string) {
  const project = await db()
    .selectFrom("projects")
    .select("last_event_at")
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();
  return project.last_event_at;
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
    expect(response.json()).toEqual({ received: 2 });
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

  test("stores ref as the source when there is no utm_source", async () => {
    const project = await createProject();
    const response = await send(
      batch(project.public_key, [
        pageview({ occurredAt: NOW - 2000, url: `https://${SITE}/?ref=newsletter` }),
        pageview({
          occurredAt: NOW - 1000,
          url: `https://${SITE}/?ref=newsletter&utm_source=launch`,
        }),
      ]),
    );

    expect(response.statusCode).toBe(202);
    const stored = await storedEvents(project.id);
    expect(stored.map((event) => event.utm_source)).toEqual(["newsletter", "launch"]);
  });

  test("keeps a hash router's route in the path, and never a token in the fragment", async () => {
    const project = await createProject();
    const urls = [
      `https://${SITE}/#/pricing?plan=team`,
      `https://${SITE}/app/#/products/42`,
      `https://${SITE}/#access_token=s3cret&token_type=bearer`,
      `https://${SITE}/#/callback&code=s3cret`,
      `https://${SITE}/#/access_token=s3cret`,
    ];
    const response = await send(
      batch(
        project.public_key,
        urls.map((url, index) => pageview({ occurredAt: NOW - 5000 + index, url })),
      ),
    );

    expect(response.statusCode).toBe(202);
    const stored = await storedEvents(project.id);
    expect(stored.map((event) => event.path)).toEqual([
      "/#/pricing",
      "/app/#/products/42",
      "/",
      "/",
      "/",
    ]);
    expect(JSON.stringify(stored)).not.toContain("s3cret");
  });

  test("answers the same for every outcome, so a sender cannot tell which filter caught it", async () => {
    const project = await insertProject(db(), {
      name: "Filters",
      allowed_hostnames: [SITE],
      blocked_addresses: ["198.51.100.0/24"],
      require_signed_user_ids: true,
    });
    const day = 24 * 60 * 60 * 1000;
    const answers = [
      await send(batch(project.public_key, pageviews(2))),
      await send(batch(project.public_key, pageviews(2)), { remoteAddress: "198.51.100.1" }),
      await send(batch(project.public_key, pageviews(2)), { headers: { "user-agent": "curl/8" } }),
      await send(
        batch(
          project.public_key,
          pageviews(2).map((event) => ({ ...event, referrer: "https://semalt.com/" })),
        ),
      ),
      await send(batch(project.public_key, [pageview({ occurredAt: NOW - day - 1 }), pageview()])),
      await send(batch(project.public_key, [pageview({ userId: "42" }), pageview()])),
    ];
    for (const answer of answers) {
      expect({ status: answer.statusCode, body: answer.json() }).toEqual({
        status: 202,
        body: { received: 2 },
      });
    }
  });

  test("accepts application/json as well as text/plain", async () => {
    const project = await createProject();
    const response = await send(batch(project.public_key), {
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(202);
  });

  test.each([
    ["a sender whose clock is right", 0],
    ["a sender whose clock is 10 minutes slow", -10 * 60 * 1000],
    ["a sender whose clock is 10 minutes fast", 10 * 60 * 1000],
  ])("counts a retried batch once, from %s", async (_label, clockError) => {
    let clock = NOW;
    const instance = appWith({ collection: { now: () => clock } });
    const project = await createProject();
    // By the sender's clock: two events, then the batch sent at once.
    const at = NOW - 3000 + clockError;
    const events = [pageview({ occurredAt: at }), pageview({ occurredAt: at + 1000 })];

    // The first attempt took 80 ms, but its answer was lost.
    clock = NOW + 80;
    const first = await send(batch(project.public_key, events, { sentAt: NOW + clockError }), {
      instance,
    });
    // The tracker sends the batch again 2 seconds later, with a new sentAt,
    // and this time it takes 4 seconds.
    clock = NOW + 6000;
    const retry = await send(
      batch(project.public_key, events, { sentAt: NOW + 2000 + clockError }),
      { instance },
    );

    expect(first.json()).toEqual({ received: 2 });
    // Each answer counts what it was sent: the server looks nothing up.
    expect(retry.json()).toEqual({ received: 2 });
    // The retry's times are later by the extra time on the way, about 4
    // seconds, but on the same day: ClickHouse keeps each event once.
    expect(await countEvents(clickhouse(), project.id)).toBe(2);
    const stored = await storedEvents(project.id);
    expect(new Set(stored.map((event) => event.event_id)).size).toBe(2);
    for (const event of stored) {
      expect(event.occurred_at.getTime()).toBeGreaterThanOrEqual(NOW - 2920);
      expect(event.occurred_at.getTime()).toBeLessThanOrEqual(NOW + 2000);
    }
  });

  test("counts events older than 24 hours as too old and stores the rest", async () => {
    const project = await createProject();
    const day = 24 * 60 * 60 * 1000;
    const response = await send(
      batch(project.public_key, [pageview({ occurredAt: NOW - day - 1 }), pageview()]),
    );
    expect(response.json()).toEqual({ received: 2 });
    expect(await storedEvents(project.id)).toHaveLength(1);
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

    test("rejects a body with a __proto__ or constructor key, as Fastify's JSON parser does", async () => {
      const project = await createProject();
      const json = JSON.stringify(batch(project.public_key));
      for (const body of [
        json.replace("{", '{"__proto__":{"admin":true},'),
        json.replace("{", '{"constructor":{"prototype":{"admin":true}},'),
        json.replace('"name":"pageview"', '"name":"pageview","properties":{"__proto__":"x"}'),
      ]) {
        const response = await send(body);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "invalid_request" });
      }
      expect(await storedEvents(project.id)).toHaveLength(0);
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

  describe("requests in progress", () => {
    test("503 past the process's limit, 429 past one project's, shared with server events, each given back", async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let inserts = 0;
      // A ClickHouse that holds every insert until the gate opens.
      const held = {
        insert: async () => {
          inserts += 1;
          await gate;
        },
      } as unknown as ClickHouseClient;
      const instance = appWith({
        collection: { now: () => NOW, clickhouse: held, maxInFlight: 3, maxInFlightPerProject: 2 },
      });
      try {
        const ours = await createProject();
        const theirs = await createProject();
        const sendTo = (key: string) => send(batch(key), { instance });

        const waiting = [sendTo(ours.public_key), sendTo(ours.public_key)];
        await expect.poll(() => inserts).toBe(2);
        const projectFull = await sendTo(ours.public_key);
        expect(projectFull.statusCode).toBe(429);
        expect(projectFull.headers["retry-after"]).toBe("1");

        waiting.push(sendTo(theirs.public_key));
        await expect.poll(() => inserts).toBe(3);
        const processFull = await sendTo(theirs.public_key);
        expect(processFull.statusCode).toBe(503);
        expect(processFull.headers["retry-after"]).toBe("1");
        expect(processFull.json()).toMatchObject({ error: "busy" });
        const { secret_key: secretKey } = await db()
          .selectFrom("projects")
          .select("secret_key")
          .where("id", "=", theirs.id)
          .executeTakeFirstOrThrow();
        const fromServer = await instance.inject({
          method: "POST",
          url: "/api/server-events",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secretKey}`,
          },
          payload: JSON.stringify({
            v: 1,
            events: [{ id: randomUUID(), name: "paid", occurredAt: NOW - 1000, userId: "42" }],
          }),
        });
        expect(fromServer.statusCode).toBe(503);

        open();
        for (const response of await Promise.all(waiting)) expect(response.statusCode).toBe(202);
        // Every slot was given back.
        expect((await sendTo(ours.public_key)).statusCode).toBe(202);
        expect((await sendTo(ours.public_key)).statusCode).toBe(202);
        expect((await sendTo(theirs.public_key)).statusCode).toBe(202);
      } finally {
        open();
      }
    });

    test("browsers that fill a project's slots do not hold its server events back", async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let inserts = 0;
      const held = {
        insert: async () => {
          inserts += 1;
          await gate;
        },
      } as unknown as ClickHouseClient;
      const instance = appWith({
        collection: { now: () => NOW, clickhouse: held, maxInFlightPerProject: 1 },
      });
      try {
        const project = await createProject();
        const { secret_key: secretKey } = await db()
          .selectFrom("projects")
          .select("secret_key")
          .where("id", "=", project.id)
          .executeTakeFirstOrThrow();
        const waiting = [send(batch(project.public_key), { instance })];
        await expect.poll(() => inserts).toBe(1);
        expect((await send(batch(project.public_key), { instance })).statusCode).toBe(429);
        const fromServer = (userId: string) =>
          instance.inject({
            method: "POST",
            url: "/api/server-events",
            headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
            payload: JSON.stringify({
              v: 1,
              events: [{ id: randomUUID(), name: "paid", occurredAt: NOW - 1000, userId }],
            }),
          });
        waiting.push(fromServer("42"));
        await expect.poll(() => inserts).toBe(2);
        // The servers' own slot is full now, and only theirs.
        expect((await fromServer("43")).statusCode).toBe(429);
        open();
        for (const response of await Promise.all(waiting)) expect(response.statusCode).toBe(202);
      } finally {
        open();
      }
    });

    test("ClickHouse gets 10 seconds to write a batch", async () => {
      const settings: unknown[] = [];
      const recording = {
        insert: async (options: { clickhouse_settings?: unknown }) => {
          settings.push(options.clickhouse_settings);
        },
      } as unknown as ClickHouseClient;
      const instance = appWith({ collection: { now: () => NOW, clickhouse: recording } });
      const project = await createProject();
      const { secret_key: secretKey } = await db()
        .selectFrom("projects")
        .select("secret_key")
        .where("id", "=", project.id)
        .executeTakeFirstOrThrow();
      expect((await send(batch(project.public_key), { instance })).statusCode).toBe(202);
      const fromServer = await instance.inject({
        method: "POST",
        url: "/api/server-events",
        headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
        payload: JSON.stringify({
          v: 1,
          events: [{ id: randomUUID(), name: "paid", occurredAt: NOW - 1000, userId: "42" }],
        }),
      });
      expect(fromServer.statusCode).toBe(202);
      expect(settings).toEqual([
        expect.objectContaining({ wait_for_async_insert: 1, wait_for_async_insert_timeout: 10 }),
        expect.objectContaining({ wait_for_async_insert: 1, wait_for_async_insert_timeout: 10 }),
      ]);
    });

    test("a body that breaks the schema takes no slot", async () => {
      const instance = appWith({ collection: { now: () => NOW, maxInFlight: 1 } });
      const project = await createProject();
      for (let i = 0; i < 3; i += 1) {
        expect((await send("{not json", { instance })).statusCode).toBe(400);
      }
      expect((await send(batch(project.public_key), { instance })).statusCode).toBe(202);
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
      // Cross-origin scripts need explicit access to the response and Retry-After header.
      expect(fromBrowser.headers["access-control-allow-origin"]).toBe(`https://${SITE}`);
      expect(fromBrowser.headers["access-control-expose-headers"]).toBe("Retry-After");

      // Another address has its own bucket.
      const other = await send(body, { instance: limited, remoteAddress: "198.51.100.7" });
      expect(other.statusCode).toBe(202);
    });

    test("counts the addresses of one IPv6 /64 as one client", async () => {
      const limited = appWith({
        collection: { now: () => NOW, ipLimit: { capacity: 2, refillPerSecond: 1 } },
      });
      const project = await createProject();
      const body = batch(project.public_key);
      for (const address of ["2001:db8:1:2::1", "2001:db8:1:2::2"]) {
        expect((await send(body, { instance: limited, remoteAddress: address })).statusCode).toBe(
          202,
        );
      }
      const third = await send(body, { instance: limited, remoteAddress: "2001:db8:1:2::3" });
      expect(third.statusCode).toBe(429);
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

    test("a batch refused for its events' rules spends no budget", async () => {
      const limited = appWith({
        collection: { now: () => NOW, projectLimit: { capacity: 50, refillPerSecond: 1 } },
      });
      const project = await createProject();
      const refused = [
        [...pageviews(49), pageview({ url: "javascript:alert(1)" })],
        [...pageviews(49), pageview({ url: "https://elsewhere.example/" })],
        [...pageviews(49), { ...pageview(), name: "engagement", properties: { engagedMs: -1 } }],
      ];
      for (const events of refused) {
        const response = await send(batch(project.public_key, events), { instance: limited });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(429);
      }
      const full = await send(batch(project.public_key, pageviews(50)), { instance: limited });
      expect(full.statusCode).toBe(202);
    });

    test("a batch over its budget is refused before the location lookup and signatures", async () => {
      let lookups = 0;
      const limited = appWith({
        collection: {
          now: () => NOW,
          projectLimit: { capacity: 50, refillPerSecond: 0.001 },
          locate: () => {
            lookups += 1;
            return {};
          },
        },
      });
      const project = await createProject();
      expect(
        (await send(batch(project.public_key, pageviews(50)), { instance: limited })).statusCode,
      ).toBe(202);
      expect(lookups).toBe(1);
      const over = await send(batch(project.public_key, pageviews(1)), { instance: limited });
      expect(over.statusCode).toBe(429);
      expect(lookups).toBe(1);
    });

    test("refuses to start with a project limit smaller than one batch", () => {
      const tooSmall = appWith({
        collection: { projectLimit: { capacity: 10, refillPerSecond: 1 } },
      });
      return expect(tooSmall.ready()).rejects.toThrow(/full batch/);
    });
    test("keeps the instance's projects inside one budget", async () => {
      const limited = appWith({
        collection: {
          now: () => NOW,
          projectLimit: { capacity: 50, refillPerSecond: 0.001 },
          instanceLimit: { capacity: 80, refillPerSecond: 0.001 },
        },
      });
      const first = await insertProject(db(), { name: "Site", allowed_hostnames: [SITE] });
      const second = await insertProject(db(), { name: "Docs", allowed_hostnames: [SITE] });

      expect(
        (await send(batch(first.public_key, pageviews(50)), { instance: limited })).statusCode,
      ).toBe(202);
      // The second project has its own 50, but the instance only 30 left.
      const over = await send(batch(second.public_key, pageviews(31)), { instance: limited });
      expect(over.statusCode).toBe(429);
      expect(
        (await send(batch(second.public_key, pageviews(30)), { instance: limited })).statusCode,
      ).toBe(202);
      // Adding a project does not add to the instance's budget.
      const third = await createProject();
      expect(
        (await send(batch(third.public_key, pageviews(1)), { instance: limited })).statusCode,
      ).toBe(429);
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

    describe("each project's location source", () => {
      const HEADERS = {
        location_source: "headers" as const,
        location_country_header: "x-visitor-country",
        location_region_header: "x-visitor-region",
        location_city_header: "x-visitor-city",
      };
      const FROM_PROXY = { "x-ottertrail-trusted-proxy": "true" };

      test("headers, with the API not behind a proxy (TRUST_PROXY unset): nothing is read, even with the trust header", async () => {
        const project = await sourceProject(HEADERS);
        await send(batch(project.public_key), {
          headers: { ...FROM_PROXY, "x-visitor-country": "FR", "x-visitor-city": "Paris" },
        });
        const [event] = await storedEvents(project.id);
        expect(event).toMatchObject({ country: null, region: null, city: null });
      });

      test("database, the default: the lookup, as before", async () => {
        const { instance, calls } = countingApp();
        const project = await createProject();
        expect((await send(batch(project.public_key), { instance })).statusCode).toBe(202);
        expect(calls).toEqual(["203.0.113.10"]);
        const [event] = await storedEvents(project.id);
        expect(event).toMatchObject({ country: "DE", region: "Bavaria", city: "Munich" });
      });

      test("off: no location, and no lookup", async () => {
        const { instance, calls } = countingApp();
        const project = await sourceProject({ location_source: "off" });
        await send(batch(project.public_key), {
          instance,
          headers: { ...FROM_PROXY, "x-visitor-country": "FR" },
        });
        expect(calls).toEqual([]);
        const [event] = await storedEvents(project.id);
        expect(event).toMatchObject({ country: null, region: null, city: null });
      });

      test("headers through a trusted proxy: the values the headers give, and no lookup", async () => {
        const { instance, calls } = countingApp();
        const project = await sourceProject(HEADERS);
        await send(batch(project.public_key), {
          instance,
          headers: {
            ...FROM_PROXY,
            "x-visitor-country": "fr",
            "x-visitor-region": "  Île-de-France ",
            "x-visitor-city": "Paris",
          },
        });
        expect(calls).toEqual([]);
        const [event] = await storedEvents(project.id);
        expect(event).toMatchObject({ country: "FR", region: "Île-de-France", city: "Paris" });
      });

      test.each([
        ["absent", {}],
        ["false", { "x-ottertrail-trusted-proxy": "false" }],
        ["anything but true", { "x-ottertrail-trusted-proxy": "1" }],
      ])("headers with the trust header %s: ignored, with no fallback", async (_, trust) => {
        const { instance, calls } = countingApp();
        const project = await sourceProject(HEADERS);
        await send(batch(project.public_key), {
          instance,
          headers: { ...trust, "x-visitor-country": "FR", "x-visitor-city": "Paris" },
        });
        expect(calls).toEqual([]);
        const [event] = await storedEvents(project.id);
        expect(event).toMatchObject({ country: null, region: null, city: null });
      });

      test.each(["XX", "T1", "FRA", "F", "1A", "", "ZZ"])(
        "headers: the country %j is dropped, the city kept",
        async (country) => {
          const { instance } = countingApp();
          const project = await sourceProject(HEADERS);
          await send(batch(project.public_key), {
            instance,
            headers: { ...FROM_PROXY, "x-visitor-country": country, "x-visitor-city": "Paris" },
          });
          const [event] = await storedEvents(project.id);
          expect(event).toMatchObject({ country: null, region: null, city: "Paris" });
        },
      );

      test("headers: percent-encoded UTF-8 is decoded; control characters and missing headers leave the field empty", async () => {
        const { instance } = countingApp();
        const project = await sourceProject(HEADERS);
        await send(batch(project.public_key), {
          instance,
          headers: {
            ...FROM_PROXY,
            "x-visitor-country": "CH",
            "x-visitor-city": "Z%C3%BCrich",
            "x-visitor-region": "Zur%00ich",
          },
        });
        const [event] = await storedEvents(project.id);
        expect(event).toMatchObject({ country: "CH", region: null, city: "Zürich" });
      });

      test("headers: a long city ending in an emoji is cut whole, and the batch is stored", async () => {
        const { instance } = countingApp();
        const project = await sourceProject(HEADERS);
        const response = await send(batch(project.public_key), {
          instance,
          headers: {
            ...FROM_PROXY,
            "x-visitor-country": "DE",
            "x-visitor-city": `${"a".repeat(99)}%F0%9F%98%80`,
            "x-visitor-region": "203.0.113.10",
          },
        });
        expect(response.statusCode).toBe(202);
        const [event] = await storedEvents(project.id);
        // The address is never stored, even as a region.
        expect(event).toMatchObject({ country: "DE", region: null, city: "a".repeat(99) });
      });

      test("headers: raw UTF-8 and Latin-1 bytes on the wire, as Node reads them", async () => {
        const { instance } = countingApp();
        await instance.listen({ host: "127.0.0.1", port: 0 });
        const { port } = instance.server.address() as AddressInfo;
        const project = await sourceProject(HEADERS);
        const body = JSON.stringify(batch(project.public_key));
        const raw = Buffer.concat([
          Buffer.from(
            [
              "POST /api/events HTTP/1.1",
              `host: 127.0.0.1:${port}`,
              "content-type: text/plain",
              `user-agent: ${CHROME_MAC}`,
              "x-ottertrail-trusted-proxy: true",
              "x-visitor-country: DE",
              "x-visitor-city: ",
            ].join("\r\n"),
          ),
          Buffer.from("Köln", "utf8"),
          Buffer.from("\r\nx-visitor-region: "),
          // Latin-1, which is not valid UTF-8: read as Latin-1.
          Buffer.from("D\xfcsseldorf", "latin1"),
          Buffer.from(
            `\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
          ),
        ]);
        const answer = await new Promise<string>((resolve, reject) => {
          // Written, not ended: the server would close a half-closed socket before its async answer.
          const socket = connect(port, "127.0.0.1", () => socket.write(raw));
          let text = "";
          socket.on("data", (chunk) => (text += chunk.toString("latin1")));
          socket.on("close", () => resolve(text));
          socket.on("error", reject);
        });
        expect(answer).toMatch(/^HTTP\/1\.1 202/);
        const [event] = await storedEvents(project.id);
        expect(event).toMatchObject({ country: "DE", region: "Düsseldorf", city: "Köln" });
      });
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

    test("records an iPad, which says it is a Mac, from the tracker's touch hint", async () => {
      const project = await createProject();
      const safariOnIpad =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
      await send(batch(project.public_key, [pageview()], { touch: true }), {
        headers: { "user-agent": safariOnIpad },
      });
      await send(batch(project.public_key), { headers: { "user-agent": safariOnIpad } });
      const events = await storedEvents(project.id);
      expect(events.map((event) => [event.os, event.device_type])).toEqual(
        expect.arrayContaining([
          ["iOS", "tablet"],
          ["macOS", "desktop"],
        ]),
      );
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
      expect(response.json()).toEqual({ received: 2 });
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

    describe("from data centers", () => {
      const CLOUD = "198.51.100.77";
      const cloudAware = () =>
        appWith({ collection: { now: () => NOW, isDataCenter: (ip) => ip === CLOUD } });

      test("accepts and ignores a browser at a cloud provider's address, as a bot", async () => {
        const instance = cloudAware();
        const project = await createProject();
        const response = await send(batch(project.public_key, [pageview(), pageview()]), {
          instance,
          remoteAddress: CLOUD,
        });
        expect(response.statusCode).toBe(202);
        expect(response.json()).toEqual({ received: 2 });
        expect(await storedEvents(project.id)).toHaveLength(0);

        // The same browser from anywhere else counts.
        const home = await send(batch(project.public_key, [pageview()]), { instance });
        expect(home.statusCode).toBe(202);
        expect(await storedEvents(project.id)).toHaveLength(1);
      });

      test("counts them for a project that turned this off", async () => {
        const project = await insertProject(db(), {
          name: "Remote desktops",
          allowed_hostnames: [SITE],
          ignore_data_centers: false,
        });
        const response = await send(batch(project.public_key, [pageview()]), {
          instance: cloudAware(),
          remoteAddress: CLOUD,
        });
        expect(response.statusCode).toBe(202);
        expect(await storedEvents(project.id)).toHaveLength(1);
      });
    });
  });

  describe("errors", () => {
    const STACK = `TypeError: Cannot read properties of undefined (reading 'total')
    at renderCart (https://${SITE}/assets/index-BfK3x9A2.js:1:2345)`;
    const errorEvent = (error: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
      pageview({ name: "error", error, ...overrides });

    test("stores an error with its details and its group", async () => {
      const project = await createProject();
      const event = errorEvent(
        {
          type: "TypeError",
          message: "Cannot read properties of undefined (reading 'total')\n\tin the cart",
          stack: STACK,
        },
        { userId: "42" },
      );
      const caught = errorEvent({ type: "Error", message: "Payment declined", handled: true });
      const response = await send(batch(project.public_key, [event, caught]));
      expect(response.json()).toEqual({ received: 2 });

      const stored = await storedEvents(project.id);
      const row = stored.find((item) => item.event_id === event.id);
      expect(row).toMatchObject({
        name: "error",
        user_id: "42",
        error_type: "TypeError",
        error_message: "Cannot read properties of undefined (reading 'total')\n\tin the cart",
        error_stack: STACK,
        error_handled: false,
      });
      expect(row?.error_fingerprint).toMatch(/^1-[0-9a-f]{20}$/);
      expect(row?.visitor_id).not.toBeNull();
      expect(stored.find((item) => item.event_id === caught.id)).toMatchObject({
        error_handled: true,
        error_stack: null,
      });
    });

    test("an event named error without details is a custom event, as before errors", async () => {
      const project = await createProject();
      const response = await send(batch(project.public_key, [pageview({ name: "error" })]));
      expect(response.json()).toEqual({ received: 1 });
      const [row] = await storedEvents(project.id);
      expect(row).toMatchObject({ name: "error", error_fingerprint: null, error_type: null });
    });

    test("groups the same error from two deploys together", async () => {
      const project = await createProject();
      const before = errorEvent({ type: "TypeError", message: "x is undefined", stack: STACK });
      const after = errorEvent({
        type: "TypeError",
        message: "x is undefined",
        stack: STACK.replace("index-BfK3x9A2.js:1:2345", "index-Zq81LmP0.js:1:9001"),
      });
      await send(batch(project.public_key, [before, after]));
      const [first, second] = await storedEvents(project.id);
      expect(first?.error_fingerprint).toBe(second?.error_fingerprint);
    });

    test.each([
      [pageview({ error: { type: "Error", message: "x" } }), "details on a pageview"],
      [errorEvent({ message: "no type" }), "no type"],
      [errorEvent({ type: "", message: "x" }), "an empty type"],
      [errorEvent({ type: "Type\nError", message: "x" }), "a line break in the type"],
      [errorEvent({ type: "Error", message: "bell \u0007" }), "a control character in the message"],
      [errorEvent({ type: "Error", message: "x".repeat(2001) }), "a message over 2,000 characters"],
      [
        errorEvent({ type: "Error", message: "x", stack: "s".repeat(16_001) }),
        "a stack over 16,000",
      ],
      [errorEvent({ type: "Error", message: "\ud800" }), "an unpaired surrogate"],
    ])("refuses %j (%s)", async (event) => {
      const project = await createProject();
      const response = await send(batch(project.public_key, [event]));
      expect(response.statusCode).toBe(400);
      expect(await storedEvents(project.id)).toHaveLength(0);
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

      const instance = appWith({ collection: { now: () => now } });
      try {
        await setInstanceTimeZone(db(), "Asia/Singapore");
        const inSingapore = await createProject();
        await send(twoEvents(inSingapore.public_key), { instance });
        expect(new Set(await visitorIds(inSingapore.id)).size).toBe(1);
      } finally {
        await setInstanceTimeZone(db(), "UTC");
      }
      const inUtc = await createProject();
      await send(twoEvents(inUtc.public_key), { instance });
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

  describe("links and not found pages", () => {
    test("keeps a link's origin and path and its host, nothing else", async () => {
      const project = await createProject();
      const outbound = pageview({
        name: "outbound_link",
        properties: {
          url: "https://user:secret@Docs.Example.org/guide?token=1#top",
          text: "Guide",
        },
      });
      const download = pageview({
        name: "file_download",
        properties: { url: `https://${SITE}/files/report.pdf?v=2` },
      });
      const notFound = pageview({ name: "not_found", properties: { typed: "secret" } });
      const response = await send(batch(project.public_key, [outbound, download, notFound]));
      expect(response.json()).toEqual({ received: 3 });

      const stored = await storedEvents(project.id);
      const byId = (id: string) => stored.find((event) => event.event_id === id);
      expect(byId(outbound.id)).toMatchObject({
        name: "outbound_link",
        path: "/lessons/closures",
        properties: { url: "https://docs.example.org/guide", host: "docs.example.org" },
      });
      expect(byId(download.id)?.properties).toEqual({
        url: `https://${SITE}/files/report.pdf`,
        host: SITE,
      });
      expect(byId(notFound.id)).toMatchObject({ name: "not_found", path: "/lessons/closures" });
      expect(byId(notFound.id)?.properties).toEqual({});
    });

    test.each([
      ["no url", {}],
      ["a url that is not http(s)", { url: "mailto:team@example.com" }],
      ["text that is not a URL", { url: "report.pdf" }],
      ["a number", { url: 42 }],
      ["a url over 500 characters", { url: `https://example.org/${"a".repeat(481)}` }],
    ])("rejects a link event with %s", async (_label, properties) => {
      const project = await createProject();
      for (const name of ["outbound_link", "file_download"]) {
        const response = await send(
          batch(project.public_key, [pageview(), pageview({ name, properties })]),
        );
        expect(response.statusCode).toBe(400);
      }
      expect(await storedEvents(project.id)).toHaveLength(0);
    });
  });

  describe("Web Vitals", () => {
    test("keeps a page load's vitals, and drops impossible ones", async () => {
      const project = await createProject();
      const report = pageview({
        name: "vitals",
        properties: { lcp: 2346, inp: 88, cls: 0.1235, fcp: 900, ttfb: 120 },
      });
      const odd = pageview({
        name: "vitals",
        properties: { lcp: -5, inp: 12.5, cls: 101, fcp: 700_000, ttfb: "fast", ok: 1 },
      });
      const response = await send(batch(project.public_key, [report, odd]));
      // The event and its batch are kept either way.
      expect(response.json()).toEqual({ received: 2 });

      const stored = await storedEvents(project.id);
      expect(stored.find((event) => event.event_id === report.id)?.properties).toEqual({
        lcp: 2346,
        inp: 88,
        cls: 0.1235,
        fcp: 900,
        ttfb: 120,
      });
      // Nothing but valid values stays: not even another property.
      expect(stored.find((event) => event.event_id === odd.id)?.properties).toEqual({});
    });
  });

  describe("environment and release", () => {
    test("stores the batch's environment, in lower case, and release on every event", async () => {
      const project = await createProject();
      const response = await send(
        batch(project.public_key, [pageview(), pageview({ name: "signup" })], {
          environment: "Staging",
          release: "web@1.4.2+3f2a9c1",
        }),
      );
      expect(response.statusCode).toBe(202);
      const stored = await storedEvents(project.id);
      expect(stored.map(({ environment, release }) => ({ environment, release }))).toEqual([
        { environment: "staging", release: "web@1.4.2+3f2a9c1" },
        { environment: "staging", release: "web@1.4.2+3f2a9c1" },
      ]);
    });

    test("without them, events are production's, with no release", async () => {
      const project = await createProject();
      await send(batch(project.public_key));
      const [event] = await storedEvents(project.id);
      expect(event).toMatchObject({ environment: "production", release: null });
    });

    test.each([
      [{ environment: "" }, "an empty environment"],
      [{ environment: "my staging" }, "a space in the environment"],
      [{ environment: "-staging" }, "an environment starting with a dash"],
      [{ environment: "s".repeat(65) }, "an environment over 64 characters"],
      [{ release: "" }, "an empty release"],
      [{ release: "1.4 beta" }, "a space in the release"],
      [{ release: "1.4\u0000" }, "a control character in the release"],
      [{ release: "1.4\u0085" }, "a C1 control character in the release"],
      [{ release: "1.4\u00A0" }, "a no-break space in the release"],
      [{ release: "1".repeat(201) }, "a release over 200 characters"],
      [{ release: "1.4.\uD800" }, "an unpaired surrogate in the release"],
    ] as [object, string][])("refuses %j (%s)", async (fields) => {
      const project = await createProject();
      // JSON keeps the control character and the lone surrogate as escapes.
      const response = await send(batch(project.public_key, [pageview()], fields));
      expect(response.statusCode).toBe(400);
      expect(await storedEvents(project.id)).toHaveLength(0);
    });
  });

  describe("known users", () => {
    test("stores each event's user ID as sent, and none for an anonymous one", async () => {
      const project = await createProject();
      const response = await send(
        batch(project.public_key, [
          pageview({ occurredAt: NOW - 3000 }),
          pageview({ occurredAt: NOW - 2000, userId: "user 42/ä" }),
          pageview({ occurredAt: NOW - 1000, name: "signup", userId: "user 42/ä" }),
        ]),
      );
      expect(response.statusCode).toBe(202);
      const stored = await storedEvents(project.id);
      expect(stored.map((event) => event.user_id)).toEqual([null, "user 42/ä", "user 42/ä"]);
    });

    test.each([
      ["", "an empty user ID"],
      ["u".repeat(201), "a user ID over 200 characters"],
      ["user\u000042", "a control character"],
      ["user\u008542", "a C1 control character"],
      ["user\uD80042", "an unpaired surrogate"],
    ])("refuses %j (%s)", async (userId) => {
      const project = await createProject();
      const response = await send(batch(project.public_key, [pageview({ userId })]));
      expect(response.statusCode).toBe(400);
      expect(await storedEvents(project.id)).toHaveLength(0);
    });
  });

  describe("signed user IDs", () => {
    const SECRET = "sk_00000000000000000000000000000001";
    // HMAC-SHA256("42") with SECRET, worked out apart from the code under test.
    const SIGNED_42 = "cd39dcecfe1dab56c3167aadc4175538cc535737786788fb11552b3028d9bbf4";

    test("when required, keeps a correctly signed ID and drops the rest, keeping the events", async () => {
      const project = await signingProject(true, SECRET);
      const response = await send(
        batch(project.public_key, [
          pageview({ occurredAt: NOW - 3000, userId: "42", userSignature: SIGNED_42 }),
          // Someone else's ID with 42's signature.
          pageview({ occurredAt: NOW - 2000, userId: "43", userSignature: SIGNED_42 }),
          // No signature at all.
          pageview({ occurredAt: NOW - 1000, userId: "42" }),
        ]),
      );
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ received: 3 });
      const stored = await storedEvents(project.id);
      expect(stored.map((event) => event.user_id)).toEqual(["42", null, null]);
    });

    test("when not required, takes the ID as sent", async () => {
      const project = await signingProject(false);
      await send(batch(project.public_key, [pageview({ userId: "43" })]));
      const [event] = await storedEvents(project.id);
      expect(event?.user_id).toBe("43");
    });

    test("refuses a signature that is not 64 hex digits", async () => {
      const project = await signingProject(true);
      for (const userSignature of [SIGNED_42.slice(1), `${SIGNED_42.slice(1)}g`]) {
        const response = await send(
          batch(project.public_key, [pageview({ userId: "42", userSignature })]),
        );
        expect({ userSignature, status: response.statusCode }).toEqual({
          userSignature,
          status: 400,
        });
      }
    });
  });

  describe("visits across midnight", () => {
    test("splits a visit at midnight in the instance's timezone, with no link between the days", async () => {
      let clock = Date.parse("2026-11-16T15:50:00.000Z"); // 23:50 in Singapore
      const singapore = appWith({ collection: { now: () => clock } });
      await setInstanceTimeZone(db(), "Asia/Singapore");
      onTestFinished(() => setInstanceTimeZone(db(), "UTC"));
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

      const visits = await findVisits(
        { client: clickhouse() },
        {
          projectId: project.id,
          environment: "production",
          from: new Date("2026-11-16T00:00:00Z"),
          to: new Date("2026-11-17T00:00:00Z"),
        },
      );
      expect(visits.map((visit) => visit.entryPath)).toEqual(["/", "/docs"]);
    });
  });

  describe("the project's latest event", () => {
    test("is recorded at once, then at most once a minute, and a late, earlier event leaves it", async () => {
      let clock = NOW;
      const instance = appWith({ collection: { now: () => clock } });
      const project = await createProject();
      const other = await createProject();
      const at = (offset: number) => pageview({ occurredAt: clock + offset });
      const sendAt = (key: string, events: unknown[]) =>
        send(batch(key, events, { sentAt: clock }), { instance });
      expect(await lastEventAt(project.id)).toBeNull();

      // Recorded after the answer, so the test waits for it.
      await sendAt(project.public_key, [at(-5000), at(-1000)]);
      await sendAt(other.public_key, [at(-9000)]);
      await expect.poll(() => lastEventAt(project.id)).toEqual(new Date(NOW - 1000));
      await expect.poll(() => lastEventAt(other.id)).toEqual(new Date(NOW - 9000));

      // Within the minute: stored, not recorded.
      clock = NOW + 30_000;
      await sendAt(project.public_key, [at(0)]);
      expect(await lastEventAt(project.id)).toEqual(new Date(NOW - 1000));

      // A minute on, the next request records its latest event.
      clock = NOW + 61_000;
      await sendAt(project.public_key, [at(0)]);
      await expect.poll(() => lastEventAt(project.id)).toEqual(new Date(NOW + 61_000));

      // Sent late from a browser that was offline: it happened before the latest.
      clock = NOW + 130_000;
      await sendAt(project.public_key, [at(-60 * 60 * 1000)]);
      expect(await lastEventAt(project.id)).toEqual(new Date(NOW + 61_000));
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

  describe("when storage fails", () => {
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

    test("answers 503, never 202, and stores nothing, if ClickHouse cannot take the events", async () => {
      const unreachable = createClickHouse(
        { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
        { database: testClickHouse?.database ?? "default" },
      );
      try {
        const broken = appWith({
          collection: {
            now: () => NOW,
            clickhouse: unreachable,
            projectLimit: { capacity: 50, refillPerSecond: 0.001 },
          },
        });
        const project = await createProject();

        // Retry to check that a failed write refunds the budget.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          // A full batch: the whole budget.
          const response = await send(batch(project.public_key, pageviews(50)), {
            instance: broken,
          });
          expect(response.statusCode).toBe(503);
          expect(response.headers["retry-after"]).toBe("5");
          expect(response.json()).toMatchObject({ error: "storage_unavailable" });
        }
        expect(await countEvents(clickhouse(), project.id)).toBe(0);
        // Nor is the project's latest event recorded.
        expect(await lastEventAt(project.id)).toBeNull();
      } finally {
        await unreachable.close();
      }
    });

    // Request impossible free space to trigger NOT_ENOUGH_SPACE, as the 5% disk
    // limit in deploy/clickhouse/config.d/ottertrail.xml would on a full disk.
    test("answers 503 and stores nothing while ClickHouse refuses inserts for lack of disk", async () => {
      const setting = (ratio: number) =>
        clickhouse().command({
          query: `ALTER TABLE events MODIFY SETTING min_free_disk_ratio_to_perform_insert = ${ratio}`,
        });
      const instance = appWith({ collection: { now: () => NOW } });
      const project = await createProject();
      await setting(0.99999);
      try {
        const response = await send(batch(project.public_key), { instance });
        expect(response.statusCode).toBe(503);
        expect(response.headers["retry-after"]).toBe("5");
        expect(response.json()).toMatchObject({ error: "storage_unavailable" });
        expect(await countEvents(clickhouse(), project.id)).toBe(0);
      } finally {
        await setting(0);
      }
      // With room again, the retry is stored.
      expect((await send(batch(project.public_key), { instance })).statusCode).toBe(202);
      expect(await countEvents(clickhouse(), project.id)).toBe(1);
    });
  });
});
