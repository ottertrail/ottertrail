import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { type AppOptions, buildApp } from "../src/app.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../src/config.ts";
import type { ObjectStore } from "../src/storage/object-store.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { countEvents, storedEvents } from "./helpers/events.ts";
import { insertProject } from "./helpers/projects.ts";

const SITE = "example.com";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
const extraApps: FastifyInstance[] = [];

beforeAll(async () => {
  dashboard = await signedInDashboard();
});

afterAll(async () => {
  await Promise.all(extraApps.map((app) => app.close()));
  await dashboard?.close();
});

/** Another app on the same databases, with its own collection limits and caches. */
function appWith(
  collection: Partial<AppOptions["collection"]> = {},
  options: Partial<AppOptions> = {},
) {
  const app = buildApp({
    db: dashboard.db,
    ...options,
    collection: { clickhouse: dashboard.reader.client, ...collection },
  });
  extraApps.push(app);
  return app;
}

async function newProject(
  values: { blocked_addresses?: string[]; blocked_referrers?: string[] } = {},
) {
  return insertProject(dashboard.db, {
    name: `Site ${randomUUID().slice(0, 8)}`,
    allowed_hostnames: [SITE],
    ...values,
  });
}

function pageview(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: "pageview",
    occurredAt: Date.now() - 1000,
    url: `https://${SITE}/`,
    ...overrides,
  };
}

const pageviews = (count: number, overrides: Record<string, unknown> = {}) =>
  Array.from({ length: count }, () => pageview(overrides));

function send(
  key: string,
  events: unknown[],
  {
    app = dashboard.app,
    remoteAddress = "198.51.100.10",
    userAgent = CHROME,
  }: { app?: FastifyInstance; remoteAddress?: string; userAgent?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/events",
    headers: { "content-type": "text/plain", "user-agent": userAgent },
    payload: JSON.stringify({ v: 1, key, sentAt: Date.now(), events }),
    remoteAddress,
  });
}

function patch(projectId: string, body: object, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

const count = (projectId: string) => countEvents(dashboard.reader.client, projectId);

/** A clock that stands still, so no tokens return between requests. */
function stopped() {
  const now = Date.now();
  return () => now;
}

describe("the per-client event limit", () => {
  test("counts events, not requests, and answers 429 with Retry-After", async () => {
    const app = appWith({ now: stopped() });
    const project = await newProject();
    // A burst of 200 events: four full batches pass, the fifth waits 50 / 20 a second.
    for (let i = 0; i < 4; i += 1) {
      expect((await send(project.public_key, pageviews(50), { app })).statusCode).toBe(202);
    }
    const refused = await send(project.public_key, pageviews(50), { app });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("3");
    expect(refused.json()).toMatchObject({ error: "rate_limited" });
    // Another address has its own bucket.
    const other = await send(project.public_key, pageviews(50), {
      app,
      remoteAddress: "198.51.100.11",
    });
    expect(other.statusCode).toBe(202);
  });

  test("an IPv6 /64 shares one bucket; another /64 has its own", async () => {
    const app = appWith({ now: stopped() });
    const project = await newProject();
    for (let i = 0; i < 4; i += 1) {
      const response = await send(project.public_key, pageviews(50), {
        app,
        remoteAddress: `2001:db8:5:6::${i + 1}`,
      });
      expect(response.statusCode).toBe(202);
    }
    const sameBlock = await send(project.public_key, pageviews(1), {
      app,
      remoteAddress: "2001:db8:5:6:ffff::9",
    });
    expect(sameBlock.statusCode).toBe(429);
    const otherBlock = await send(project.public_key, pageviews(1), {
      app,
      remoteAddress: "2001:db8:5:7::1",
    });
    expect(otherBlock.statusCode).toBe(202);
  });
});

describe("the daily cap per visitor", () => {
  test("events past it are answered 202, counted, and not stored", async () => {
    const app = appWith({ visitorCap: 3 });
    const project = await newProject();
    const first = await send(project.public_key, pageviews(2), { app });
    expect(first.json()).toMatchObject({ stored: 2, capped: 0 });
    const second = await send(project.public_key, pageviews(2), { app });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({
      stored: 1,
      tooOld: 0,
      bots: 0,
      unverifiedUsers: 0,
      blocked: 0,
      spam: 0,
      capped: 1,
    });
    // Another browser on the same address is another visitor.
    const other = await send(project.public_key, pageviews(2), { app, userAgent: FIREFOX });
    expect(other.json()).toMatchObject({ stored: 2, capped: 0 });
    expect(await count(project.id)).toBe(5);
  });

  test("capped events spend no budget", async () => {
    const app = appWith({
      visitorCap: 1,
      projectLimit: { capacity: 50, refillPerSecond: 0.001 },
    });
    const project = await newProject();
    expect((await send(project.public_key, pageviews(1), { app })).json()).toMatchObject({
      stored: 1,
    });
    // 49 left: a capped batch of 49 is refunded, so the next is still allowed.
    expect((await send(project.public_key, pageviews(49), { app })).json()).toMatchObject({
      stored: 0,
      capped: 49,
    });
    const next = await send(project.public_key, pageviews(49), { app, userAgent: FIREFOX });
    expect(next.statusCode).toBe(202);
    expect(next.json()).toMatchObject({ stored: 1, capped: 48 });
  });

  test("a batch ClickHouse could not write gives back its budget and its visitor's counts", async () => {
    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: dashboard.clickhouseDatabase },
    );
    try {
      const app = appWith({
        clickhouse: unreachable,
        visitorCap: 50,
        projectLimit: { capacity: 50, refillPerSecond: 0.001 },
      });
      const project = await newProject();
      const batch = pageviews(50);
      // Twice: without the budget back the retry gets 429, without the
      // counts back its events are capped (202); with both, 503 again.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await send(project.public_key, batch, { app });
        expect(response.statusCode).toBe(503);
      }
    } finally {
      await unreachable.close();
    }
  });

  test("server-side events are not capped", async () => {
    const app = appWith({ visitorCap: 1 });
    const project = await newProject();
    const { secret_key: secretKey } = await dashboard.db
      .selectFrom("projects")
      .select("secret_key")
      .where("id", "=", project.id)
      .executeTakeFirstOrThrow();
    const response = await app.inject({
      method: "POST",
      url: "/api/server-events",
      headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
      payload: JSON.stringify({
        v: 1,
        events: Array.from({ length: 5 }, () => ({
          id: randomUUID(),
          name: "paid",
          occurredAt: Date.now() - 1000,
          userId: "42",
        })),
      }),
    });
    expect(response.statusCode).toBe(202);
    expect(await count(project.id)).toBe(5);
  });
});

describe("blocked addresses", () => {
  test("a change applies on the next request: IPv4, a range, IPv6, and IPv4-mapped", async () => {
    const created = await dashboard.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Blocking", allowedHostnames: [SITE] }),
    });
    const { project } = created.json();
    // Loaded into the key cache, unblocked.
    expect((await send(project.publicKey, [pageview()])).json()).toMatchObject({ stored: 1 });

    const changed = await patch(project.id, {
      blockedAddresses: ["198.51.100.0/24", "2001:DB8:9::/64", "203.0.113.7", "203.0.113.7/32"],
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().project.blockedAddresses).toEqual([
      "198.51.100.0/24",
      "2001:db8:9::/64",
      "203.0.113.7",
    ]);

    for (const remoteAddress of [
      "198.51.100.10",
      "::ffff:198.51.100.77",
      "203.0.113.7",
      "2001:db8:9::1234",
    ]) {
      const response = await send(project.publicKey, pageviews(2), { remoteAddress });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        stored: 0,
        tooOld: 0,
        bots: 0,
        unverifiedUsers: 0,
        blocked: 2,
        spam: 0,
        capped: 0,
      });
    }
    expect(
      (await send(project.publicKey, [pageview()], { remoteAddress: "203.0.113.8" })).json(),
    ).toMatchObject({ stored: 1, blocked: 0 });
    expect(await count(project.id)).toBe(2);

    // Emptied: the next request is stored again.
    await patch(project.id, { blockedAddresses: [] });
    expect((await send(project.publicKey, [pageview()])).json()).toMatchObject({ stored: 1 });
  });

  test("are refused when malformed or more than 100, and nothing changes", async () => {
    const project = await newProject({ blocked_addresses: ["203.0.113.7"] });
    const bad = await patch(project.id, { blockedAddresses: ["203.0.113.0/24", "not an address"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_address" });
    const many = await patch(project.id, {
      blockedAddresses: Array.from({ length: 101 }, (_, i) => `198.51.${i}.1`),
    });
    expect(many.statusCode).toBe(400);
    const row = await dashboard.db
      .selectFrom("projects")
      .select("blocked_addresses")
      .where("id", "=", project.id)
      .executeTakeFirstOrThrow();
    expect(row.blocked_addresses).toEqual(["203.0.113.7"]);
  });

  test("blocked and spam batches spend no budget", async () => {
    const app = appWith({ projectLimit: { capacity: 50, refillPerSecond: 0.001 } });
    const project = await newProject({ blocked_addresses: ["203.0.113.0/24"] });
    for (let i = 0; i < 3; i += 1) {
      const blocked = await send(project.public_key, pageviews(50), {
        app,
        remoteAddress: `203.0.113.${i + 1}`,
      });
      expect(blocked.json()).toMatchObject({ blocked: 50 });
      const spam = await send(
        project.public_key,
        pageviews(50, { referrer: "https://semalt.com/" }),
        { app, remoteAddress: `198.51.100.${i + 20}` },
      );
      expect(spam.json()).toMatchObject({ spam: 50 });
    }
    const real = await send(project.public_key, pageviews(50), {
      app,
      remoteAddress: "198.51.100.99",
    });
    expect(real.statusCode).toBe(202);
    expect(real.json()).toMatchObject({ stored: 50 });
  });

  test("do not apply to server-side events", async () => {
    const project = await newProject({ blocked_addresses: ["203.0.113.0/24"] });
    const { secret_key: secretKey } = await dashboard.db
      .selectFrom("projects")
      .select("secret_key")
      .where("id", "=", project.id)
      .executeTakeFirstOrThrow();
    const response = await dashboard.app.inject({
      method: "POST",
      url: "/api/server-events",
      headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
      payload: JSON.stringify({
        v: 1,
        events: [{ id: randomUUID(), name: "paid", occurredAt: Date.now() - 1000, userId: "42" }],
      }),
      remoteAddress: "203.0.113.5",
    });
    expect(response.statusCode).toBe(202);
    expect(await count(project.id)).toBe(1);
  });

  test("replay chunks from a blocked address are accepted and dropped", async () => {
    const unused: ObjectStore = {
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      deletePrefix: () => Promise.resolve(0),
      close: () => undefined,
    };
    const app = appWith({}, { objectStore: unused, replays: { limitBytes: 1024 ** 3 } });
    const project = await insertProject(dashboard.db, {
      name: "Replays",
      allowed_hostnames: [SITE],
      replay_mode: "errors",
      blocked_addresses: ["203.0.113.0/24"],
    });
    const chunk = (remoteAddress: string) =>
      app.inject({
        method: "POST",
        url: `/api/replays?key=${project.public_key}&replay=${randomUUID()}&seq=0&last=0&cut=0`,
        headers: { "content-type": "text/plain", "user-agent": CHROME },
        payload: gzipSync('[{"type":4}'),
        remoteAddress,
      });
    const blocked = await chunk("203.0.113.9");
    expect(blocked.statusCode).toBe(202);
    expect(blocked.json()).toEqual({ stored: 0 });
    const chunks = async () =>
      (
        await dashboard.db
          .selectFrom("replay_chunks")
          .select("seq")
          .where("project_id", "=", project.id)
          .execute()
      ).length;
    expect(await chunks()).toBe(0);
    expect((await chunk("198.51.100.4")).json()).toEqual({ stored: 1 });
    expect(await chunks()).toBe(1);
  });

  test("members without the projects permission neither see nor set them", async () => {
    const project = await newProject({
      blocked_addresses: ["203.0.113.7"],
      blocked_referrers: ["spam.example"],
    });
    const { cookie } = await signedInUser(dashboard, {
      name: "Mia",
      email: `mia-${randomUUID()}@example.com`,
      grants: { projects: "all", areas: { web_analytics: "view", errors: "manage" } },
    });
    const one = await dashboard.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
      headers: { cookie },
    });
    expect(one.statusCode).toBe(200);
    // A member sees the project's icon, never its settings.
    expect(Object.keys(one.json().project).toSorted()).toEqual([
      "avatarUrl",
      "createdAt",
      "id",
      "lastEventAt",
      "name",
    ]);
    const list = await dashboard.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie },
    });
    expect(JSON.stringify(list.json())).not.toContain("203.0.113.7");
    expect(JSON.stringify(list.json())).not.toContain("spam.example");
    expect((await patch(project.id, { blockedAddresses: [] }, cookie)).statusCode).toBe(403);
    expect((await patch(project.id, { blockedReferrers: [] }, cookie)).statusCode).toBe(403);
    // The owner sees both.
    const full = await dashboard.app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
      headers: { cookie: dashboard.cookie },
    });
    expect(full.json().project).toMatchObject({
      blockedAddresses: ["203.0.113.7"],
      blockedReferrers: ["spam.example"],
    });
  });

  test("the own-address route answers the requester's address, for those who manage projects", async () => {
    const own = (remoteAddress: string, cookie = dashboard.cookie) =>
      dashboard.app.inject({
        method: "GET",
        url: "/api/client-address",
        headers: { cookie },
        remoteAddress,
      });
    expect((await own("2001:db8:1:2::7")).json()).toEqual({
      address: "2001:db8:1:2::7",
      network: "2001:db8:1:2::/64",
    });
    expect((await own("::ffff:198.51.100.4")).json()).toEqual({
      address: "198.51.100.4",
      network: null,
    });
    const { cookie } = await signedInUser(dashboard, {
      name: "Max",
      email: `max-${randomUUID()}@example.com`,
      grants: { projects: "all", areas: { web_analytics: "view" } },
    });
    expect((await own("198.51.100.4", cookie)).statusCode).toBe(403);
    expect(
      (await dashboard.app.inject({ method: "GET", url: "/api/client-address" })).statusCode,
    ).toBe(401);
  });

  test("TRUST_PROXY applies to the own-address route", async () => {
    const proxied = buildApp({
      db: dashboard.db,
      trustProxy: true,
      dashboard: {
        auth: dashboard.auth,
        clickhouse: dashboard.reader.client,
        publicUrl: PUBLIC_URL,
        trustedOrigins: [PUBLIC_URL],
      },
    });
    extraApps.push(proxied);
    const response = await proxied.inject({
      method: "GET",
      url: "/api/client-address",
      headers: { cookie: dashboard.cookie, "x-forwarded-for": "203.0.113.50" },
      remoteAddress: "10.0.0.2",
    });
    expect(response.json()).toEqual({ address: "203.0.113.50", network: null });
  });
});

describe("referrer spam", () => {
  test.each([
    ["Matomo's list", "https://semalt.com/"],
    ["Matomo's list, a subdomain", "https://www.semalt.com/promo"],
    ["Ottertrail's additions", "https://check-additions.ottertrail.invalid/"],
  ])("a domain from %s is answered 202, counted, and not stored", async (_source, referrer) => {
    const project = await newProject();
    const response = await send(project.public_key, [
      pageview({ referrer }),
      { ...pageview(), name: "engagement", properties: { engagedMs: 1000 } },
    ]);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ stored: 0, spam: 2 });
    expect(await count(project.id)).toBe(0);
  });

  test("a lookalike that is not a subdomain is kept", async () => {
    const project = await newProject();
    for (const referrer of ["https://notsemalt.com/", "https://semalt.com.example.org/"]) {
      expect((await send(project.public_key, [pageview({ referrer })])).json()).toMatchObject({
        stored: 1,
        spam: 0,
      });
    }
    expect((await storedEvents(dashboard.reader.client, project.id)).length).toBe(2);
  });

  test("a project's own domains apply to it alone, from the next request after a change", async () => {
    const mine = await newProject();
    const other = await newProject();
    const referrer = "https://deals.spam.example/offer";
    // Loaded into the key cache before the change.
    expect((await send(mine.public_key, [pageview({ referrer })])).json()).toMatchObject({
      stored: 1,
    });
    const changed = await patch(mine.id, { blockedReferrers: ["https://Spam.Example:8443/x"] });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().project.blockedReferrers).toEqual(["spam.example"]);
    expect((await send(mine.public_key, [pageview({ referrer })])).json()).toMatchObject({
      stored: 0,
      spam: 1,
    });
    expect((await send(other.public_key, [pageview({ referrer })])).json()).toMatchObject({
      stored: 1,
      spam: 0,
    });
    expect(await count(mine.id)).toBe(1);
  });

  test("a referrer on the project's own site is never spam, whatever the lists hold", async () => {
    // A site whose own domain is on Matomo's list: its pages refer each other.
    const project = await insertProject(dashboard.db, {
      name: "Listed site",
      allowed_hostnames: ["semalt.com"],
    });
    const response = await send(project.public_key, [
      pageview({ url: "https://semalt.com/b", referrer: "https://semalt.com/a" }),
    ]);
    expect(response.json()).toMatchObject({ stored: 1, spam: 0 });
  });

  test("blocking the project's own site, or a parent of it, is refused", async () => {
    const project = await insertProject(dashboard.db, {
      name: "Own site",
      allowed_hostnames: ["www.shop.example"],
    });
    for (const entry of ["shop.example", "www.shop.example"]) {
      const response = await patch(project.id, { blockedReferrers: [entry] });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain("would block your own site, www.shop.example");
    }
    // Against the allowed sites sent in the same change.
    const both = await patch(project.id, {
      allowedHostnames: ["deals.example"],
      blockedReferrers: ["shop.example"],
    });
    expect(both.statusCode).toBe(200);
    expect(
      (
        await patch(project.id, {
          allowedHostnames: ["a.deals.example"],
          blockedReferrers: ["deals.example"],
        })
      ).statusCode,
    ).toBe(400);
  });

  test("a project's own domains are refused when not domains or more than 100", async () => {
    const project = await newProject();
    expect((await patch(project.id, { blockedReferrers: ["co.uk"] })).statusCode).toBe(400);
    const bad = await patch(project.id, { blockedReferrers: ["com"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_referrer" });
    const many = await patch(project.id, {
      blockedReferrers: Array.from({ length: 101 }, (_, i) => `spam-${i}.example`),
    });
    expect(many.statusCode).toBe(400);
  });
});
