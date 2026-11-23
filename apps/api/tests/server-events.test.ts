import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { ProjectKeyCache } from "../src/collection/project-keys.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { replaceSecretKey } from "../src/projects/projects.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { countEvents, storedEvents } from "./helpers/events.ts";
import { insertProject } from "./helpers/projects.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

async function secretKeyOf(id: string): Promise<string> {
  const row = await dashboard.db
    .selectFrom("projects")
    .select("secret_key")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row.secret_key;
}
let projectId = "";
let secretKey = "";
let publicKey = "";

beforeAll(async () => {
  dashboard = await signedInDashboard();
  const project = await insertProject(dashboard.db, {
    name: "Server events",
    allowed_hostnames: ["example.com"],
  });
  projectId = project.id;
  publicKey = project.public_key;
  secretKey = await secretKeyOf(projectId);
});

afterAll(async () => {
  await dashboard?.close();
});

function serverEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: "subscription_started",
    occurredAt: Date.now() - 1000,
    userId: "42",
    ...overrides,
  };
}

function send(body: unknown, headers: Record<string, string> = {}) {
  return dashboard.app.inject({
    method: "POST",
    url: "/api/server-events",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secretKey}`,
      ...headers,
    },
    payload: JSON.stringify(body),
  });
}

/** The event with this ID in ClickHouse, if it is there. */
async function stored(id: string) {
  return (await storedEvents(dashboard.reader.client, projectId)).find(
    (event) => event.event_id === id,
  );
}

describe("POST /api/server-events", () => {
  test("stores a server's events for a user, without a visitor or a page", async () => {
    const event = serverEvent({ properties: { plan: "team", seats: 5 } });
    const withPage = serverEvent({ name: "checkout_failed", path: "/checkout" });
    const response = await send({
      v: 1,
      environment: "Staging",
      release: "api@2.3.0",
      events: [event, withPage],
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ stored: 2, tooOld: 0 });

    expect(await stored(event.id)).toMatchObject({
      name: "subscription_started",
      user_id: "42",
      path: null,
      visitor_id: null,
      browser: null,
      country: null,
      properties: { plan: "team", seats: 5 },
      environment: "staging",
      release: "api@2.3.0",
    });
    expect(await stored(withPage.id)).toMatchObject({ path: "/checkout" });
  });

  test("counts a retried event once: its time is stored as sent", async () => {
    const project = await insertProject(dashboard.db, {
      name: "Retries",
    });
    const key = await secretKeyOf(project.id);
    const event = serverEvent();
    await send({ v: 1, events: [event] }, { authorization: `Bearer ${key}` });
    const again = await send({ v: 1, events: [event] }, { authorization: `Bearer ${key}` });
    expect(again.json()).toEqual({ stored: 1, tooOld: 0 });
    expect(await countEvents(dashboard.reader.client, project.id)).toBe(1);
  });

  test("needs the project's secret key, checked before the body is read", async () => {
    for (const authorization of [undefined, "Bearer pk_00000000000000000000000000000000", "sk_x"]) {
      const response = await dashboard.app.inject({
        method: "POST",
        url: "/api/server-events",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        // Not even valid JSON: the key is checked first.
        payload: "{",
      });
      expect({ authorization, status: response.statusCode }).toEqual({
        authorization,
        status: 401,
      });
    }
    // The public key is not a secret key.
    const withPublic = await send(
      { v: 1, events: [serverEvent()] },
      {
        authorization: `Bearer ${publicKey.replace("pk_", "sk_")}`,
      },
    );
    expect(withPublic.statusCode).toBe(401);
    expect(withPublic.json().error).toBe("unknown_key");
    // A well-formed key no project has is refused before the body is read too.
    const unknown = await send("{", { authorization: `Bearer sk_${"0".repeat(32)}` });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe("unknown_key");
  });

  test.each([
    [{ name: "pageview" }, "a pageview, which only the tracker sends"],
    [{ name: "engagement" }, "an engagement report"],
    [{ name: "vitals" }, "a page load's Web Vitals"],
    [{ userId: undefined }, "no user ID"],
    [{ userId: "" }, "an empty user ID"],
    [{ path: "/checkout?step=2" }, "a path with a query"],
    [{ path: "checkout" }, "a path without its leading slash"],
    [{ occurredAt: Date.now() + 10 * 60 * 1000 }, "a time ten minutes ahead"],
    [{ properties: { nested: { a: 1 } } }, "nested properties"],
  ] as [Record<string, unknown>, string][])("refuses %j (%s)", async (overrides) => {
    const event = serverEvent(overrides);
    const response = await send({ v: 1, events: [event] });
    expect(response.statusCode).toBe(400);
    expect(await stored(event.id)).toBeUndefined();
  });

  test("refuses a body over 64 KB", async () => {
    const events = Array.from({ length: 50 }, () =>
      serverEvent({ properties: { text: "x".repeat(1500) } }),
    );
    const response = await send({ v: 1, events });
    expect(response.statusCode).toBe(413);
    expect(await stored(events[0]!.id)).toBeUndefined();
  });

  test("answers 503, for a retry, if the key cannot be looked up", async () => {
    const unreachable = createDatabase({
      connectionString: "postgres://unused@127.0.0.1:1/unused",
    });
    const broken = buildApp({
      db: unreachable,
      collection: { clickhouse: dashboard.reader.client },
    });
    try {
      const response = await broken.inject({
        method: "POST",
        url: "/api/server-events",
        headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
        payload: JSON.stringify({ v: 1, events: [serverEvent()] }),
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.json()).toMatchObject({ error: "storage_unavailable" });
    } finally {
      await broken.close();
      await unreachable.destroy();
    }
  });

  test("answers 503, for a retry, and stores nothing, if ClickHouse cannot take the events", async () => {
    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: dashboard.clickhouseDatabase },
    );
    const broken = buildApp({ db: dashboard.db, collection: { clickhouse: unreachable } });
    const event = serverEvent();
    try {
      const response = await broken.inject({
        method: "POST",
        url: "/api/server-events",
        headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
        payload: JSON.stringify({ v: 1, events: [event] }),
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.json()).toMatchObject({ error: "storage_unavailable" });
      expect(await stored(event.id)).toBeUndefined();
    } finally {
      await broken.close();
      await unreachable.close();
    }
  });

  test("a key replaced while its lookup runs is not cached", async () => {
    const project = await insertProject(dashboard.db, {
      name: "Replaced",
    });
    const oldKey = await secretKeyOf(project.id);
    const cache = new ProjectKeyCache(dashboard.db);
    const lookup = cache.findBySecret(oldKey);
    // The key is replaced and forgotten while the lookup still runs, which
    // read the old row.
    cache.forgetProject(project.id);
    expect(await lookup).toMatchObject({ id: project.id });
    await replaceSecretKey(dashboard.db, project.id);
    expect(await cache.findBySecret(oldKey)).toBeNull();
  });

  test("a key replaced while the body arrives stores nothing", async () => {
    const project = await insertProject(dashboard.db, { name: "Rotated mid-request" });
    const key = await secretKeyOf(project.id);
    const body = new PassThrough();
    const pending = dashboard.app.inject({
      method: "POST",
      url: "/api/server-events",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      payload: body,
    });
    const json = JSON.stringify({ v: 1, events: [serverEvent()] });
    body.write(json.slice(0, 10));
    // The key is looked up before the body: give it the time to be.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const replaced = await dashboard.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/secret-key`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    });
    expect(replaced.statusCode).toBe(200);
    body.end(json.slice(10));
    const response = await pending;
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "unknown_key" });
    expect(await countEvents(dashboard.reader.client, project.id)).toBe(0);
  });

  test("counts an event over a day old instead of storing it", async () => {
    const event = serverEvent({ occurredAt: Date.now() - 25 * 60 * 60 * 1000 });
    const response = await send({ v: 1, events: [event] });
    expect(response.json()).toEqual({ stored: 0, tooOld: 1 });
  });

  test("never lets a page read the answer: a page must not hold the secret key", async () => {
    const response = await send(
      { v: 1, events: [serverEvent()] },
      { origin: "https://example.com" },
    );
    expect(response.statusCode).toBe(202);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("shows in the user's activity, and not in web analytics", async () => {
    const event = serverEvent({ userId: "server-user", name: "invoice_paid" });
    await send({ v: 1, events: [event] });
    await send({ v: 1, environment: "billing-worker", events: [serverEvent()] });

    const user = await dashboard.app.inject({
      url: `/api/projects/${projectId}/users/server-user`,
      headers: { cookie: dashboard.cookie },
    });
    expect(user.json().activity).toMatchObject([{ name: "invoice_paid", path: "" }]);

    const analytics = await dashboard.app.inject({
      url: `/api/projects/${projectId}/analytics?period=today`,
      headers: { cookie: dashboard.cookie },
    });
    expect(analytics.json().customEvents).toEqual([]);
    // Nor in its environment picker.
    expect(analytics.json().environments).not.toContain("billing-worker");
  });
});
