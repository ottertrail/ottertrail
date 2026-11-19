import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { migrations } from "../src/db/migrations/index.ts";
import {
  garageAdmin,
  plannedQuota,
  probeOpenAdminApi,
  QUOTA_STEP_BYTES,
} from "../src/storage/garage-admin.ts";
import { NO_TOKEN_MESSAGE } from "../src/storage/routes.ts";
import type { Disk, StorageSources } from "../src/storage/usage.ts";
import { StorageWarningJob } from "../src/storage/warning-job.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { type FakeGarage, startFakeGarage } from "./helpers/fake-garage.ts";
import { createTestDatabase, migrateTestDatabase } from "./helpers/test-database.ts";

const GiB = 1024 ** 3;
const TOKEN = "a-garage-admin-token-only-these-tests-use-0123";
const BUDGETS = { replayBytes: 2 * GiB, sourceMapBytes: 1 * GiB };

let garage: FakeGarage;
let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
/** The disk the app and the job see; a test sets it, or makes it fail. */
let disk: Disk | Error;
let project: { id: string };

function request(cookie: string | undefined, method: "GET" | "PATCH", payload?: object) {
  return dashboard.app.inject({
    method,
    url: "/api/settings/storage",
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      origin: PUBLIC_URL,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

const readDisk = async () => {
  if (disk instanceof Error) throw disk;
  return disk;
};

const roomyDisk = (): Disk => ({
  totalBytes: 100 * GiB,
  freeBytes: 60 * GiB,
  readOnly: false,
  broken: false,
});

/** A webhook channel of the instance. */
async function channel(name: string) {
  return dashboard.db
    .insertInto("notification_channels")
    .values({
      name,
      kind: "webhook",
      webhook_url: "https://hooks.example/x",
      webhook_secret: "s".repeat(64),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

function job(budgets = BUDGETS, room?: { freeRatio: () => Promise<number> }) {
  const sources: StorageSources = {
    db: dashboard.db,
    clickhouse: dashboard.reader.client,
    objectStore: { kind: "garage", bucket: "ottertrail" },
    budgets,
    telemetryRetentionDays: 30,
    garage: garageAdmin({ adminUrl: garage.url, adminToken: TOKEN }),
    readDisk,
  };
  const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const check = new StorageWarningJob({
    db: dashboard.db,
    sources,
    publicUrl: "https://analytics.example.com",
    log: (level, msg, fields) => logs.push({ level, msg, ...(fields ? { fields } : {}) }),
    ...(room === undefined ? {} : { room }),
  });
  return { check, logs };
}

const deliveries = () =>
  dashboard.db
    .selectFrom("notification_deliveries")
    .select(["channel_id", "event_type", "payload"])
    .orderBy("created_at")
    .orderBy("id")
    .execute();

const percentFull = (percent: number): Disk => ({
  totalBytes: 100 * GiB,
  freeBytes: ((100 - percent) / 100) * 100 * GiB,
  readOnly: false,
  broken: false,
});

async function webhook(name: string) {
  return (await channel(name)).id;
}

beforeAll(async () => {
  garage = await startFakeGarage(TOKEN);
  dashboard = await signedInDashboard({
    objectStore: {
      put: async () => undefined,
      get: async () => null,
      delete: async () => undefined,
      deletePrefix: async () => 0,
      close: () => undefined,
    },
    replays: { limitBytes: BUDGETS.replayBytes },
    sourceMaps: { limitBytes: BUDGETS.sourceMapBytes },
    telemetry: { retentionDays: 14 },
    storage: {
      objectStore: { kind: "garage", bucket: "ottertrail" },
      garage: garageAdmin({ adminUrl: garage.url, adminToken: TOKEN }),
      readDisk,
    },
  });
  project = await dashboard.db
    .insertInto("projects")
    .values({ name: "Shop", allowed_hostnames: ["shop.example"] })
    .returning("id")
    .executeTakeFirstOrThrow();
  await dashboard.db
    .insertInto("source_maps")
    .values({
      project_id: project.id,
      release: "1.0.0",
      path: "/assets/app.js",
      object_key: `source-maps/${project.id}/1.0.0/app.js.map.gz`,
      bytes: 1000,
    })
    .execute();
  await dashboard.store(project.id, [
    { eventId: randomUUID(), name: "pageview", occurredAt: new Date(), path: "/" },
  ]);
});

afterAll(async () => {
  await dashboard?.close();
  await garage?.close();
});

beforeEach(async () => {
  disk = roomyDisk();
  garage.token = TOKEN;
  garage.failWith = null;
  garage.requests.length = 0;
  garage.bucket = {
    id: "0fe090406fe8bad2bd774e9dc1cc2a84d98aae10bd1e84456aa66a80c7e2ea31",
    alias: "ottertrail",
    objects: 42,
    bytes: 1000,
    maxSize: null,
  };
  await dashboard.db.deleteFrom("storage_warnings").execute();
  await dashboard.db.deleteFrom("storage_warning_channels").execute();
  await dashboard.db.deleteFrom("notification_deliveries").execute();
  await dashboard.db.deleteFrom("notification_channels").execute();
});

describe("GET /api/settings/storage", () => {
  test("measures each store", async () => {
    const response = await request(dashboard.cookie, "GET");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      objectStore: "garage",
      disk: { ok: true, totalBytes: 100 * GiB, freeBytes: 60 * GiB, readOnly: false },
      budgets: {
        ok: true,
        replays: { usedBytes: 0, limitBytes: 2 * GiB },
        sourceMaps: { usedBytes: 1000, limitBytes: 1 * GiB },
      },
      garage: {
        state: "ok",
        bucket: { objects: 42, bytes: 1000, quotaBytes: null },
        dataPartition: { availableBytes: 70_000_000_000, totalBytes: 100_000_000_000 },
        plannedQuotaBytes: Math.ceil(3 * GiB * 1.1),
        quotaAboveBudgets: false,
      },
      warnings: [],
      held: [],
      undetermined: [],
      warningChannels: { channelIds: [], channels: [] },
    });
    expect(Date.parse(body.measuredAt)).not.toBeNaN();

    // ClickHouse: the test database's tables, each with its retention.
    expect(body.clickhouse.ok).toBe(true);
    const tables = new Map<string, { bytes: number; retention: unknown }>(
      body.clickhouse.tables.map((table: { name: string }) => [table.name, table]),
    );
    expect(tables.get("events")?.bytes).toBeGreaterThan(0);
    expect(tables.get("events")?.retention).toEqual({ kind: "projects", keptForever: 1 });
    // Tables with no parts are not listed; the ones with parts are summed.
    expect(body.clickhouse.totalBytes).toBe(
      body.clickhouse.tables.reduce(
        (sum: number, table: { bytes: number }) => sum + table.bytes,
        0,
      ),
    );
    expect(body.clickhouse.largestPartition).toMatchObject({ table: expect.any(String) });
    expect(body.clickhouse.largestPartition.bytes).toBeGreaterThan(0);

    // PostgreSQL: the database, and the schema's largest tables.
    expect(body.postgres.ok).toBe(true);
    expect(body.postgres.databaseBytes).toBeGreaterThan(0);
    expect(body.postgres.tables.length).toBe(5);
    expect(body.postgres.tables[0].bytes).toBeGreaterThanOrEqual(body.postgres.tables[4].bytes);

    // The token is never in the answer, and went only in the header.
    expect(response.body).not.toContain(TOKEN);
    expect(garage.requests.map((r) => `${r.method} ${r.path}`).toSorted()).toEqual([
      "GET /v2/GetBucketInfo?globalAlias=ottertrail",
      "GET /v2/GetClusterStatus",
    ]);
    expect(garage.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("reads the real disk from ClickHouse's system.disks without an injected one", async () => {
    const sources: StorageSources = {
      db: dashboard.db,
      clickhouse: dashboard.reader.client,
      objectStore: null,
      budgets: BUDGETS,
      telemetryRetentionDays: 30,
      garage: null,
    };
    const { measureStorage } = await import("../src/storage/usage.ts");
    const reading = await measureStorage(sources);
    expect(reading.disk.ok).toBe(true);
    if (!reading.disk.ok) return;
    expect(reading.disk.totalBytes).toBeGreaterThan(0);
    expect(reading.disk.freeBytes).toBeGreaterThan(0);
    expect(reading.disk.freeBytes).toBeLessThanOrEqual(reading.disk.totalBytes);
    expect(reading.budgets).toBeNull();
    expect(reading.garage).toBeNull();
    expect(reading.objectStore).toBe("none");
  });

  test("the owner and admins may read it; members may not, nor anyone signed out", async () => {
    const admin = await signedInUser(dashboard, {
      name: "Dee",
      email: `dee-${randomUUID()}@example.com`,
      role: "admin",
    });
    const member = await signedInUser(dashboard, {
      name: "Carol",
      email: `carol-${randomUUID()}@example.com`,
      grants: { projects: "all", areas: { errors: "manage", replays: "view" } },
    });
    expect((await request(dashboard.cookie, "GET")).statusCode).toBe(200);
    expect((await request(admin.cookie, "GET")).statusCode).toBe(200);
    const byMember = await request(member.cookie, "GET");
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json()).toMatchObject({ error: "forbidden" });
    expect((await request(undefined, "GET")).statusCode).toBe(401);
    // Changing the channels: the same people.
    expect((await request(admin.cookie, "PATCH", { warningChannelIds: [] })).statusCode).toBe(200);
    expect((await request(member.cookie, "PATCH", { warningChannelIds: [] })).statusCode).toBe(403);
  });

  test("returns the warnings with the figures, measured with the injected disk", async () => {
    // 95% full: critical. The budgets' 3 GiB of room still fits the 5 GiB free.
    disk = { totalBytes: 100 * GiB, freeBytes: 5 * GiB, readOnly: false, broken: false };
    const body = (await request(dashboard.cookie, "GET")).json();
    expect(body.warnings.map((w: { id: string; level: string }) => `${w.id}:${w.level}`)).toEqual([
      "disk_used:critical",
    ]);
    expect(body.warnings[0]).toMatchObject({ title: "The disk is 95% full" });
    expect(body.warnings[0].text).toContain("5 GB of 100 GB is free.");

    disk = { totalBytes: 100 * GiB, freeBytes: 2 * GiB, readOnly: false, broken: false };
    const tight = (await request(dashboard.cookie, "GET")).json();
    expect(tight.warnings.map((w: { id: string }) => w.id)).toEqual([
      "disk_used",
      "budgets_exceed_disk",
    ]);
  });

  test("a store that fails is reported with its reason; the others still are", async () => {
    disk = new Error("connect ECONNREFUSED 127.0.0.1:8123");
    garage.failWith = 500;
    const body = (await request(dashboard.cookie, "GET")).json();
    // A short fixed reason: the driver's message, with its address, stays in the server's log.
    expect(body.disk).toEqual({ ok: false, error: "ClickHouse did not answer." });
    expect(body.garage).toEqual({
      state: "failed",
      error: "Garage's admin API answered HTTP 500.",
    });
    expect(body.clickhouse.ok).toBe(true);
    expect(body.postgres.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    // Nothing is on, and some checks could not run: never "no warnings".
    expect(body.held).toEqual([]);
    expect(body.undetermined).toEqual([
      "merge_headroom",
      "backup_space",
      "disk_used",
      "budgets_exceed_disk",
    ]);
  });

  test("a warning on when last measured, and not measurable now, is still on", async () => {
    const since = new Date("2026-11-19T09:00:00Z");
    await dashboard.db
      .insertInto("storage_warnings")
      .values({ warning: "disk_used", level: "critical", started_at: since, updated_at: since })
      .execute();
    disk = new Error("connect ECONNREFUSED 127.0.0.1:8123");
    const body = (await request(dashboard.cookie, "GET")).json();
    expect(body.warnings).toEqual([]);
    expect(body.held).toEqual([
      {
        id: "disk_used",
        level: "critical",
        title: "The disk is nearly full",
        since: since.toISOString(),
      },
    ]);
    expect(body.undetermined).toContain("disk_used");
    // Measured again: it shows with its figures, and nothing is held.
    disk = { totalBytes: 100 * GiB, freeBytes: 5 * GiB, readOnly: false, broken: false };
    const measured = (await request(dashboard.cookie, "GET")).json();
    expect(measured.held).toEqual([]);
    expect(measured.undetermined).toEqual([]);
    expect(measured.warnings.map((w: { id: string }) => w.id)).toEqual(["disk_used"]);
  });

  test("a bucket holding more than the budgets allow: the quota sits above them", async () => {
    // 8 GiB stored under an old 10 GiB replay budget, now 2 GiB.
    garage.bucket!.bytes = 8 * GiB;
    const body = (await request(dashboard.cookie, "GET")).json();
    const room = 2 * GiB + (1 * GiB - 1000);
    const quota = Math.ceil(((8 * GiB + room) * 1.1) / QUOTA_STEP_BYTES) * QUOTA_STEP_BYTES;
    expect(body.garage).toMatchObject({ plannedQuotaBytes: quota, quotaAboveBudgets: true });
  });

  test("a refused token says what to do, without the token", async () => {
    garage.token = "garage-has-another-token-0123456789-abcdef";
    const response = await request(dashboard.cookie, "GET");
    expect(response.json().garage).toEqual({
      state: "failed",
      error:
        "Garage refused the admin token. Set the same GARAGE_ADMIN_TOKEN for Garage, the API, and the worker, then run `docker compose up -d`.",
    });
    expect(response.body).not.toContain(TOKEN);
  });

  test("without the admin token, Garage's figures are unavailable and nothing fails", async () => {
    const other = await signedInDashboard({
      objectStore: {
        put: async () => undefined,
        get: async () => null,
        delete: async () => undefined,
        deletePrefix: async () => 0,
        close: () => undefined,
      },
      storage: { objectStore: { kind: "garage", bucket: "ottertrail" }, garage: "no_token" },
    });
    try {
      const response = await other.app.inject({
        method: "GET",
        url: "/api/settings/storage",
        headers: { cookie: other.cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.garage).toEqual({ state: "no_token", message: NO_TOKEN_MESSAGE });
      expect(NO_TOKEN_MESSAGE).toContain("GARAGE_ADMIN_TOKEN");
      expect(body.disk.ok).toBe(true);
      expect(body.budgets.ok).toBe(true);
    } finally {
      await other.close();
    }
  });
});

describe("PATCH /api/settings/storage: the channels that get storage warnings", () => {
  test("none by default; saved, read back, and emptied", async () => {
    const a = await channel("Ops");
    const b = await channel("Pager");
    let body = (await request(dashboard.cookie, "GET")).json();
    expect(body.warningChannels).toEqual({
      channelIds: [],
      channels: [
        { id: a.id, name: "Ops", kind: "webhook" },
        { id: b.id, name: "Pager", kind: "webhook" },
      ],
    });
    const saved = await request(dashboard.cookie, "PATCH", {
      warningChannelIds: [b.id.toUpperCase(), a.id],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().warningChannels.channelIds).toEqual([a.id, b.id]);
    body = (await request(dashboard.cookie, "GET")).json();
    expect(body.warningChannels.channelIds).toEqual([a.id, b.id]);

    // A deleted channel leaves the setting.
    await dashboard.db.deleteFrom("notification_channels").where("id", "=", a.id).execute();
    body = (await request(dashboard.cookie, "GET")).json();
    expect(body.warningChannels.channelIds).toEqual([b.id]);

    expect(
      (await request(dashboard.cookie, "PATCH", { warningChannelIds: [] })).json().warningChannels
        .channelIds,
    ).toEqual([]);
  });

  test("refuses what is not a list of the instance's channels, and changes nothing", async () => {
    const a = await channel("Ops");
    await request(dashboard.cookie, "PATCH", { warningChannelIds: [a.id] });
    const refusals = [
      { warningChannelIds: [randomUUID()] },
      { warningChannelIds: [a.id, randomUUID()] },
      { warningChannelIds: ["not-a-uuid"] },
      { warningChannelIds: [a.id, a.id] },
      { warningChannelIds: Array.from({ length: 21 }, () => randomUUID()) },
      {},
    ];
    const statuses = [];
    for (const payload of refusals) {
      statuses.push((await request(dashboard.cookie, "PATCH", payload)).statusCode);
    }
    expect(statuses).toEqual(refusals.map(() => 400));
    const unknown = await request(dashboard.cookie, "PATCH", { warningChannelIds: [randomUUID()] });
    expect(unknown.json()).toMatchObject({ error: "channel_not_found" });
    expect((await request(dashboard.cookie, "GET")).json().warningChannels.channelIds).toEqual([
      a.id,
    ]);
    // From another site: refused before anything else.
    const foreign = await dashboard.app.inject({
      method: "PATCH",
      url: "/api/settings/storage",
      headers: {
        cookie: dashboard.cookie,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ warningChannelIds: [] }),
    });
    expect(foreign.statusCode).toBe(403);
  });
});

describe("the worker's storage check", () => {
  test("notifies the chosen channels when a warning starts, rises, and ends; never in between", async () => {
    const chosen = await webhook("Ops");
    const other = await webhook("Not chosen");
    await request(dashboard.cookie, "PATCH", { warningChannelIds: [chosen] });
    const { check, logs } = job();

    disk = percentFull(81);
    expect(await check.tick()).toMatchObject({ started: ["disk_used"], raised: [], ended: [] });
    let sent = await deliveries();
    expect(sent.map((d) => [d.channel_id, d.event_type])).toEqual([[chosen, "storage.low"]]);
    const payload = sent[0]?.payload as {
      type: string;
      project: null;
      subject: Record<string, unknown>;
      message: string;
      url: string;
    };
    expect(payload).toMatchObject({
      type: "storage.low",
      project: null,
      subject: { type: "storage", warning: "disk_used", level: "warning", usedPercent: 81 },
      url: "https://analytics.example.com/settings?tab=storage",
    });
    expect(payload.message).toMatch(/^The disk is 81% full\. /);
    expect(sent.some((d) => d.channel_id === other)).toBe(false);
    expect(logs).toContainEqual({
      level: "warn",
      msg: "a storage warning started",
      fields: { warning: "disk_used", level: "warning" },
    });

    // Still on, around the line: nothing more is sent.
    for (const percent of [82, 79.5, 80.5, 78.5]) {
      disk = percentFull(percent);
      expect(await check.tick()).toMatchObject({ started: [], raised: [], ended: [] });
    }
    expect(await deliveries()).toHaveLength(1);

    // Critical: sent again.
    disk = percentFull(91);
    expect(await check.tick()).toMatchObject({ raised: ["disk_used"] });
    // Back to a warning: not news.
    disk = percentFull(87);
    expect(await check.tick()).toMatchObject({ started: [], raised: [], ended: [] });
    // A failed measurement leaves it on.
    disk = new Error("ClickHouse is down");
    expect(await check.tick()).toMatchObject({ started: [], ended: [] });
    expect(await dashboard.db.selectFrom("storage_warnings").select("level").execute()).toEqual([
      { level: "warning" },
    ]);

    // Under the margin: it ends.
    disk = percentFull(77);
    expect(await check.tick()).toMatchObject({ ended: ["disk_used"] });
    sent = await deliveries();
    expect(sent.map((d) => d.event_type)).toEqual([
      "storage.low",
      "storage.low",
      "storage.recovered",
    ]);
    expect(sent[1]?.payload).toMatchObject({ subject: { level: "critical" } });
    expect(sent[2]?.payload).toMatchObject({
      type: "storage.recovered",
      project: null,
      subject: { type: "storage", warning: "disk_used", usedPercent: 77 },
      message: "The disk is 77% full, under 80% again: 23 GB of 100 GB is free.",
    });
    expect(await dashboard.db.selectFrom("storage_warnings").selectAll().execute()).toEqual([]);

    // And again at 80%: a new start.
    disk = percentFull(80);
    expect(await check.tick()).toMatchObject({ started: ["disk_used"] });
  });

  test("with no channel chosen, records the state and sends nothing", async () => {
    await webhook("Ops");
    const { check } = job();
    disk = percentFull(85);
    expect(await check.tick()).toMatchObject({ started: ["disk_used"] });
    expect(await deliveries()).toEqual([]);
    // Choosing a channel later does not resend a warning already on.
    const chosen = await webhook("Later");
    await request(dashboard.cookie, "PATCH", { warningChannelIds: [chosen] });
    expect(await check.tick()).toMatchObject({ started: [], raised: [] });
    expect(await deliveries()).toEqual([]);
  });

  test("merge headroom at 99%, 101%, 99% of the largest partition sends one critical storage.low", async () => {
    const chosen = await webhook("Ops");
    await request(dashboard.cookie, "PATCH", { warningChannelIds: [chosen] });
    const largest = (await request(dashboard.cookie, "GET")).json().clickhouse.largestPartition
      .bytes;
    expect(largest).toBeGreaterThan(0);
    const { check } = job();
    for (const share of [0.99, 1.01, 0.99]) {
      disk = {
        totalBytes: 100 * GiB,
        freeBytes: Math.floor(largest * share),
        readOnly: false,
        broken: false,
      };
      await check.tick();
    }
    const merge = (await deliveries()).filter(
      (delivery) =>
        (delivery.payload as { subject: { warning: string } }).subject.warning === "merge_headroom",
    );
    expect(
      merge.map((delivery) => (delivery.payload as { subject: { level: string } }).subject.level),
    ).toEqual(["critical"]);
  });

  test("a chosen channel that is deleted leaves the setting, and gets nothing", async () => {
    const chosen = await webhook("Ops");
    await request(dashboard.cookie, "PATCH", { warningChannelIds: [chosen] });
    await dashboard.db.deleteFrom("notification_channels").where("id", "=", chosen).execute();
    expect(await dashboard.db.selectFrom("storage_warning_channels").selectAll().execute()).toEqual(
      [],
    );
    const { check } = job();
    disk = percentFull(85);
    expect(await check.tick()).toMatchObject({ started: ["disk_used"] });
    expect(await deliveries()).toEqual([]);
  });

  test("two checks at once record a start once", async () => {
    const chosen = await webhook("Ops");
    await request(dashboard.cookie, "PATCH", { warningChannelIds: [chosen] });
    disk = percentFull(85);
    const results = await Promise.all([job().check.tick(), job().check.tick()]);
    // Neither failed: the second waited for the first, then found the warning on.
    expect(results.every((result) => result !== null)).toBe(true);
    expect(results.flatMap((result) => result?.started ?? [])).toEqual(["disk_used"]);
    expect(await deliveries()).toHaveLength(1);
  });

  test("sets Garage's bucket quota to the budgets plus 10%, once", async () => {
    const { check, logs } = job();
    expect(await check.tick()).toMatchObject({ quotaSet: Math.ceil(3 * GiB * 1.1) });
    expect(garage.bucket?.maxSize).toBe(Math.ceil(3 * GiB * 1.1));
    const updates = garage.requests.filter((r) => r.path.startsWith("/v2/UpdateBucket"));
    expect(updates).toEqual([
      {
        method: "POST",
        path: `/v2/UpdateBucket?id=${garage.bucket?.id}`,
        authorization: `Bearer ${TOKEN}`,
        body: { quotas: { maxSize: Math.ceil(3 * GiB * 1.1), maxObjects: null } },
      },
    ]);
    // Already set: not again.
    expect(await check.tick()).toMatchObject({ quotaSet: null });
    // A changed budget (another quota found) is set again.
    garage.bucket!.maxSize = 1;
    expect(await check.tick()).toMatchObject({ quotaSet: Math.ceil(3 * GiB * 1.1) });
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  test("a lowered budget never sets a quota below what the bucket holds plus the budgets' room", async () => {
    // 8 GiB stored under a 10 GiB replay budget, lowered to 2 GiB.
    garage.bucket!.bytes = 8 * GiB;
    const { check, logs } = job();
    const result = await check.tick();
    const room = 2 * GiB + (1 * GiB - 1000);
    expect(result?.quotaSet).toBe(
      Math.ceil(((8 * GiB + room) * 1.1) / QUOTA_STEP_BYTES) * QUOTA_STEP_BYTES,
    );
    // Every write within the budgets still fits under it.
    expect(garage.bucket!.maxSize).toBeGreaterThanOrEqual(8 * GiB + room);
    expect(logs.map((line) => line.msg)).toContain(
      "Garage's bucket quota set above the budgets: the bucket holds more than they leave room for",
    );
    // Old replays expire: the quota comes back down to the budgets plus 10%.
    garage.bucket!.bytes = 1000;
    expect((await check.tick())?.quotaSet).toBe(Math.ceil(3 * GiB * 1.1));
  });

  test("rebuilds the first-seen times a rebuild left marked, once ClickHouse has room", async () => {
    await dashboard.db
      .insertInto("first_seen_rebuilds")
      .values({ project_id: project.id })
      .execute();
    const marks = () =>
      dashboard.db.selectFrom("first_seen_rebuilds").select("project_id").execute();
    // Short of room: it waits, marked.
    const short = job(BUDGETS, { freeRatio: async () => 0.06 });
    expect(await short.check.tick()).toMatchObject({
      firstSeen: { projects: 1, outcome: "deferred" },
    });
    expect(await marks()).toEqual([{ project_id: project.id }]);
    const roomy = job(BUDGETS, { freeRatio: async () => 0.5 });
    expect(await roomy.check.tick()).toMatchObject({
      firstSeen: { projects: 1, outcome: "rebuilt" },
    });
    expect(await marks()).toEqual([]);
    expect(await roomy.check.tick()).toMatchObject({ firstSeen: { projects: 0, outcome: "none" } });
  });

  test("plannedQuota: the budgets plus 10%, or above them in steps when the bucket holds more", () => {
    const budgets = { replayBytes: 2 * GiB, sourceMapBytes: 1 * GiB };
    expect(plannedQuota(budgets)).toEqual({ bytes: Math.ceil(3 * GiB * 1.1), aboveBudgets: false });
    expect(plannedQuota(budgets, { bucketBytes: 1 * GiB, roomBytes: 2 * GiB })).toEqual({
      bytes: Math.ceil(3 * GiB * 1.1),
      aboveBudgets: false,
    });
    // The bucket holds a little more than Ottertrail counts: the room still fits.
    const little = plannedQuota(budgets, { bucketBytes: 1.1 * GiB, roomBytes: 2 * GiB });
    expect(little.bytes).toBeGreaterThanOrEqual(3.1 * GiB);
    const over = plannedQuota(budgets, { bucketBytes: 8 * GiB, roomBytes: 1 * GiB });
    expect(over.aboveBudgets).toBe(true);
    expect(over.bytes % QUOTA_STEP_BYTES).toBe(0);
    expect(over.bytes).toBeGreaterThanOrEqual(9 * GiB * 1.1);
  });

  test("without a token, the worker's probe finds Garage refusing admin requests", async () => {
    garage.token = "";
    expect(await probeOpenAdminApi(garage.url)).toBe("refused");
    // A Garage that answered without a token would be found.
    garage.failWith = 200;
    expect(await probeOpenAdminApi(garage.url)).toBe("accepted");
    expect(await probeOpenAdminApi("http://127.0.0.1:1")).toBe("unreachable");
  });

  test("a Garage that refuses the token gets no quota call; the check goes on, and logs no token", async () => {
    garage.token = "garage-has-another-token-0123456789-abcdef";
    const { check, logs } = job();
    disk = percentFull(85);
    // Its figures fail, so no quota is tried; the disk still warns.
    expect(await check.tick()).toMatchObject({ started: ["disk_used"], quotaSet: null });
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });
});

test("the migration rolls back: no storage tables", async () => {
  const names = Object.keys(migrations).toSorted();
  const previous = names[names.indexOf("0010_storage_warnings") - 1];
  expect(previous).toBeDefined();
  const testDb = await createTestDatabase();
  try {
    const tables = () =>
      sql<{ name: string }>`
        select table_name as name from information_schema.tables
        where table_schema = ${testDb.schema}
          and table_name in ('storage_warnings', 'storage_warning_channels', 'first_seen_rebuilds')
      `
        .execute(testDb.db)
        .then(({ rows }) => rows.map((row) => row.name).toSorted());
    expect(await tables()).toEqual([
      "first_seen_rebuilds",
      "storage_warning_channels",
      "storage_warnings",
    ]);
    await migrateTestDatabase(testDb, previous!);
    expect(await tables()).toEqual([]);
    await migrateTestDatabase(testDb, "latest");
    expect(await tables()).toEqual([
      "first_seen_rebuilds",
      "storage_warning_channels",
      "storage_warnings",
    ]);
  } finally {
    await testDb.destroy();
  }
});
