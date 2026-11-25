import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { ALL_AREAS } from "../src/access/areas.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { removeDeletedRows } from "../src/clickhouse/delete-events.ts";
import { clickHouseTime } from "../src/clickhouse/query.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { LOCAL_OBJECT_STORE, loadConfig } from "../src/config.ts";
import { runUserDeletions, withoutUserIds } from "../src/identities/deletions.ts";
import { replayKeyOf } from "../src/replays/replays.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, nowNs, secretKeyOf } from "./helpers/telemetry.ts";

// The development Garage from compose.yaml.
const store = s3ObjectStore(LOCAL_OBJECT_STORE);

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

beforeAll(async () => {
  dashboard = await signedInDashboard({
    objectStore: store,
    userDeletions: { ipLimit: { capacity: 30, refillPerSecond: 0.001 } },
  });
});

afterAll(async () => {
  await dashboard?.close();
});

const hourAgo = () => new Date(Date.now() - 60 * 60_000);

/** Every kind of event a user's ID is stored with: a pageview, a custom event, a server event, an error. */
function eventsOf(userId: string, replayId: string): NewEvent[] {
  const at = hourAgo();
  return [
    { eventId: randomUUID(), name: "pageview", occurredAt: at, path: "/", userId, visitorId: "7" },
    { eventId: randomUUID(), name: "signup", occurredAt: at, path: "/", userId, visitorId: "7" },
    { eventId: randomUUID(), name: "invoice_paid", occurredAt: at, userId },
    {
      eventId: randomUUID(),
      name: "error",
      occurredAt: at,
      path: "/cart",
      userId,
      visitorId: "7",
      error: {
        type: "TypeError",
        message: "x is undefined",
        handled: false,
        fingerprint: "1-0123456789abcdef0123",
        replayId,
      },
    },
  ];
}

/** A span and a log record whose attributes name the user (user.id, enduser.id). */
async function sendTelemetry(projectId: string, userId: string) {
  const key = await secretKeyOf(dashboard.db, projectId);
  const time = String(nowNs(-1000));
  const resource = { attributes: keyValues({ "service.name": "api" }) };
  const send = async (url: string, payload: object) => {
    const response = await dashboard.app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      payload: JSON.stringify(payload),
    });
    expect(response.statusCode).toBe(200);
  };
  await send("/v1/traces", {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            spans: [
              {
                traceId: randomUUID().replaceAll("-", ""),
                spanId: randomUUID().replaceAll("-", "").slice(0, 16),
                name: "GET /account",
                startTimeUnixNano: time,
                endTimeUnixNano: time,
                attributes: keyValues({ "user.id": userId }),
              },
            ],
          },
        ],
      },
    ],
  });
  await send("/v1/logs", {
    resourceLogs: [
      {
        resource,
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: time,
                body: { stringValue: "signed in" },
                attributes: keyValues({ "enduser.id": userId }),
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Two replays of the user: one found by its error event (its row not
 * linked yet), one linked to the user, its event gone; and their chunks
 * and objects.
 */
async function storeReplays(projectId: string, userId: string, viaEvent: string) {
  const linked = randomUUID();
  for (const [replayId, user] of [
    [viaEvent, null],
    [linked, userId],
  ] as const) {
    const key = replayKeyOf(projectId, replayId);
    await store.put(key, new Uint8Array([1, 2, 3]), "application/gzip");
    await dashboard.db
      .insertInto("replays")
      .values({
        project_id: projectId,
        replay_id: replayId,
        object_key: key,
        bytes: 3,
        cut: false,
        started_at: hourAgo(),
        ended_at: hourAgo(),
      })
      .execute();
    if (user !== null) {
      await dashboard.db
        .updateTable("replays")
        .set({ user_id: user, linked: true })
        .where("replay_id", "=", replayId)
        .execute();
    }
    await dashboard.db
      .insertInto("replay_chunks")
      .values({
        project_id: projectId,
        replay_id: replayId,
        seq: 0,
        last: true,
        cut: false,
        data: Buffer.from([1]),
      })
      .execute();
  }
  return [viaEvent, linked];
}

/** One user's data in every store: events, AI calls, first-seen times, spans, logs, replays. */
async function storeUser(projectId: string, userId: string) {
  const replayId = randomUUID();
  await dashboard.store(projectId, eventsOf(userId, replayId));
  await dashboard.reader.client.insert({
    table: "ai_calls",
    values: [
      {
        project_id: projectId,
        timestamp: clickHouseTime(hourAgo()),
        id: randomUUID(),
        provider: "openai",
        model: "gpt-5-mini",
        user_id: userId,
        input_tokens: 10,
        output_tokens: 5,
      },
    ],
    format: "JSONEachRow",
  });
  await sendTelemetry(projectId, userId);
  return storeReplays(projectId, userId, replayId);
}

/**
 * What each store holds of one user in one project: rows as reports see
 * them, or every row on disk; and of the replays named, their rows, chunks,
 * and objects.
 */
async function heldOf(
  projectId: string,
  userId: string,
  replayIds: readonly string[] = [],
  { onDisk = false } = {},
) {
  const count = async (table: string, where: string) => {
    const result = await dashboard.reader.client.query({
      query: `SELECT count() AS n FROM ${table} WHERE project_id = {project:UUID} AND ${where}`,
      query_params: { project: projectId, user: userId },
      format: "JSONEachRow",
      clickhouse_settings: onDisk ? { apply_deleted_mask: 0 } : {},
    });
    const [row] = await result.json<{ n: string }>();
    return Number(row?.n ?? 0);
  };
  const byUser = "user_id = {user:String}";
  const byAttribute =
    "(attributes['user.id'] = {user:String} OR attributes['enduser.id'] = {user:String})";
  const ids = replayIds.length === 0 ? [randomUUID()] : [...replayIds];
  const replays = await dashboard.db
    .selectFrom("replays")
    .select("replay_id")
    .where("project_id", "=", projectId)
    .where("replay_id", "in", ids)
    .execute();
  const chunks = await dashboard.db
    .selectFrom("replay_chunks")
    .select("replay_id")
    .where("project_id", "=", projectId)
    .where("replay_id", "in", ids)
    .execute();
  let objects = 0;
  for (const replayId of replayIds) {
    if ((await store.get(replayKeyOf(projectId, replayId))) !== null) objects += 1;
  }
  return {
    events: await count("events", byUser),
    aiCalls: await count("ai_calls", byUser),
    firstSeen: await count("user_first_seen", byUser),
    spans: await count("spans", byAttribute),
    logs: await count("logs", byAttribute),
    replays: replays.length,
    chunks: chunks.length,
    objects,
  };
}

const EVERYTHING = {
  events: 4,
  aiCalls: 1,
  firstSeen: 1,
  spans: 1,
  logs: 1,
  replays: 2,
  chunks: 2,
  objects: 2,
};
const NOTHING = {
  events: 0,
  aiCalls: 0,
  firstSeen: 0,
  spans: 0,
  logs: 0,
  replays: 0,
  chunks: 0,
  objects: 0,
};

function deleteUser(projectId: string, userId: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    method: "DELETE",
    url: `/api/projects/${projectId}/users/${encodeURIComponent(userId)}`,
    headers: { cookie, origin: PUBLIC_URL },
  });
}

function serverDelete(key: string | undefined, payload: unknown) {
  return dashboard.app.inject({
    method: "POST",
    url: "/api/user-deletions",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
    payload: JSON.stringify(payload),
  });
}

async function deletionsOf(projectId: string) {
  return dashboard.db
    .selectFrom("user_deletions")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("requested_at")
    .execute();
}

/** Runs the worker's job until nothing is due, as the worker does every minute. */
async function runJob() {
  return runUserDeletions(dashboard.db, dashboard.reader.client, store);
}

describe("deleting one user's data", { timeout: 60_000 }, () => {
  test("every store loses the user's rows and objects; other users and other projects keep theirs", async () => {
    const shop = (await insertProject(dashboard.db, { name: "Shop" })).id;
    const other = (await insertProject(dashboard.db, { name: "Other shop" })).id;
    const adas = await storeUser(shop, "ada");
    const graces = await storeUser(shop, "grace");
    const otherAdas = await storeUser(other, "ada");
    expect(await heldOf(shop, "ada", adas)).toEqual(EVERYTHING);

    const response = await deleteUser(shop, "ada");
    expect(response.statusCode).toBe(202);
    const requestedAt = response.json().deletion.requestedAt;
    expect(Date.parse(requestedAt)).not.toBeNaN();
    // Pending: the users pages say so, and nothing is deleted yet.
    const list = (
      await dashboard.app.inject({
        method: "GET",
        url: `/api/projects/${shop}/users`,
        headers: { cookie: dashboard.cookie },
      })
    ).json();
    expect(list.pendingDeletions).toEqual({ count: 1, users: [{ userId: "ada", requestedAt }] });
    expect(
      list.users.map((user: { userId: string; deletionPending: boolean }) => [
        user.userId,
        user.deletionPending,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["ada", true],
        ["grace", false],
      ]),
    );
    const page = await dashboard.app.inject({
      method: "GET",
      url: `/api/projects/${shop}/users/ada`,
      headers: { cookie: dashboard.cookie },
    });
    expect(page.json().deletionRequestedAt).toBe(requestedAt);
    // Asking again while it is pending answers the same deletion.
    expect((await deleteUser(shop, "ada")).json().deletion.requestedAt).toBe(requestedAt);

    const run = await runJob();
    expect(run).toMatchObject({ done: 1, failed: 0, replays: 2 });
    // Events, the AI call, and the first-seen time; spans and logs are queued, not counted.
    expect(run.rows).toBe(4 + 1 + 1);

    // ClickHouse masks the queued spans and logs moments later.
    await expect.poll(() => heldOf(shop, "ada", adas), { timeout: 15_000 }).toEqual(NOTHING);
    // The other user of the project, and the same ID in another project, keep everything.
    expect(await heldOf(shop, "grace", graces)).toEqual(EVERYTHING);
    expect(await heldOf(other, "ada", otherAdas)).toEqual(EVERYTHING);
    // Off the disk with a retention run once the queued deletes are done.
    await expect
      .poll(
        async () => {
          await removeDeletedRows(dashboard.reader.client, { wait: true });
          return heldOf(shop, "ada", [], { onDisk: true });
        },
        { timeout: 15_000 },
      )
      .toMatchObject({ events: 0, aiCalls: 0, firstSeen: 0, spans: 0, logs: 0 });

    // The record keeps when and by whom, not the user's ID.
    const [owner] = await dashboard.db.selectFrom("dashboard_users").select("id").execute();
    expect(await deletionsOf(shop)).toEqual([
      expect.objectContaining({
        user_id: null,
        requested_by: owner?.id,
        requested_with: "dashboard",
        attempts: 1,
        last_error: null,
        completed_at: expect.any(Date),
      }),
    ]);
    expect(
      (
        await dashboard.app.inject({
          method: "GET",
          url: `/api/projects/${shop}/users`,
          headers: { cookie: dashboard.cookie },
        })
      ).json().pendingDeletions,
    ).toEqual({ count: 0, users: [] });
    // Nothing left to do.
    expect(await runJob()).toEqual({ done: 0, failed: 0, rows: 0, replays: 0 });
  });

  test("a failed attempt waits and is tried again", async () => {
    const shop = (await insertProject(dashboard.db, { name: "Retry shop" })).id;
    await dashboard.store(shop, eventsOf("lin", randomUUID()));
    expect((await deleteUser(shop, "lin")).statusCode).toBe(202);

    const unreachable = createClickHouse(
      { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
      { database: dashboard.clickhouseDatabase },
    );
    try {
      const failed = await runUserDeletions(dashboard.db, unreachable, store);
      expect(failed).toMatchObject({ done: 0, failed: 1 });
      expect(String(failed.firstError)).toMatch(/ECONNREFUSED/);
    } finally {
      await unreachable.close();
    }
    const [waiting] = await deletionsOf(shop);
    expect(waiting).toMatchObject({ user_id: "lin", attempts: 1, completed_at: null });
    expect(waiting?.last_error).toMatch(/ECONNREFUSED/);
    expect(waiting?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    // Not due yet: the next run leaves it.
    expect(await runJob()).toMatchObject({ done: 0, failed: 0 });

    await dashboard.db
      .updateTable("user_deletions")
      .set({ next_attempt_at: sql<Date>`now()` })
      .where("project_id", "=", shop)
      .execute();
    expect(await runJob()).toMatchObject({ done: 1, failed: 0, rows: 5 });
    expect((await heldOf(shop, "lin")).events).toBe(0);
    expect(await deletionsOf(shop)).toEqual([
      expect.objectContaining({ user_id: null, attempts: 2, last_error: null }),
    ]);
  });

  test("a deletion another worker has taken is left to it until its lease ends", async () => {
    const shop = (await insertProject(dashboard.db, { name: "Leased shop" })).id;
    await dashboard.store(shop, eventsOf("kay", randomUUID()));
    expect((await deleteUser(shop, "kay")).statusCode).toBe(202);
    await dashboard.db
      .updateTable("user_deletions")
      .set({ next_attempt_at: sql<Date>`now() + interval '1 minute'`, attempts: 1 })
      .where("project_id", "=", shop)
      .execute();
    expect(await runJob()).toMatchObject({ done: 0 });
    expect((await heldOf(shop, "kay")).events).toBe(4);
  });

  test("members without the projects permission cannot delete a user's data", async () => {
    const shop = (await insertProject(dashboard.db, { name: "Guarded shop" })).id;
    const everything = await signedInUser(dashboard, {
      name: "Every area",
      email: "every-area@example.com",
      grants: { projects: [shop], areas: ALL_AREAS },
    });
    const response = await deleteUser(shop, "ada", everything.cookie);
    expect(response.statusCode).toBe(403);
    const admin = await signedInUser(dashboard, {
      name: "Admin",
      email: "admin-deletes@example.com",
      role: "admin",
    });
    expect((await deleteUser(shop, "ada", admin.cookie)).statusCode).toBe(202);
    // From another site: refused before anything is recorded.
    const elsewhere = await dashboard.app.inject({
      method: "DELETE",
      url: `/api/projects/${shop}/users/grace`,
      headers: { cookie: dashboard.cookie, origin: "https://elsewhere.example" },
    });
    expect(elsewhere.statusCode).toBe(403);
    expect((await deletionsOf(shop)).map((row) => row.user_id)).toEqual(["ada"]);
  });

  test("the app's server asks with the secret key; a public key or none deletes nothing", async () => {
    const shop = await insertProject(dashboard.db, { name: "Server shop" });
    const secret = await secretKeyOf(dashboard.db, shop.id);
    const refused = [
      await serverDelete(undefined, { userId: "ada" }),
      await serverDelete(shop.public_key, { userId: "ada" }),
      await serverDelete(`sk_${"0".repeat(32)}`, { userId: "ada" }),
    ];
    expect(refused.map((response) => [response.statusCode, response.json().error])).toEqual([
      [401, "unauthorized"],
      [401, "unauthorized"],
      [401, "unknown_key"],
    ]);
    for (const payload of [
      {},
      { userId: "" },
      { userId: "a\u0000b" },
      { userId: "x".repeat(201) },
    ]) {
      expect((await serverDelete(secret, payload)).statusCode).toBe(400);
    }
    expect(await deletionsOf(shop.id)).toEqual([]);

    const accepted = await serverDelete(secret, { userId: "ada" });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ status: "pending", requestedAt: expect.any(String) });
    expect(await deletionsOf(shop.id)).toEqual([
      expect.objectContaining({ user_id: "ada", requested_by: null, requested_with: "secret_key" }),
    ]);
  });

  test("the secret-key route is limited per address", async () => {
    const shop = await insertProject(dashboard.db, { name: "Busy shop" });
    const secret = await secretKeyOf(dashboard.db, shop.id);
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      statuses.push((await serverDelete(secret, { userId: `user-${i}` })).statusCode);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 202).length).toBeLessThanOrEqual(30);
  });
});

describe("a failed deletion's message", () => {
  test("keeps no user ID, as written or as ClickHouse quotes it", () => {
    const error = new Error(
      "Code: 47. DB::Exception: In scope SELECT ... WHERE user_id IN _CAST(['ada@example.com', 'o\\'neil', 'ada'], 'Array(String)')",
    );
    const message = withoutUserIds(error, ["ada", "o'neil", "ada@example.com"]);
    expect(message).toBe(
      "Error: Code: 47. DB::Exception: In scope SELECT ... WHERE user_id IN _CAST(['[user ID]', '[user ID]', '[user ID]'], 'Array(String)')",
    );
  });
});
