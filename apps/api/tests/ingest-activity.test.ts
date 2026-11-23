import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  ACTIVITY_MAX_KEYS,
  IngestActivity,
  INGEST_OUTCOMES,
  INGEST_SOURCES,
  type IngestOutcome,
  type IngestSource,
  pruneIngestActivity,
} from "../src/activity/activity.ts";
import { type AppOptions, buildApp } from "../src/app.ts";
import { type ClickHouseClient, createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import type { Database } from "../src/db/schema.ts";
import type { ObjectStore } from "../src/storage/object-store.ts";
import {
  LOGS_MESSAGES,
  METRICS_MESSAGES,
  TRACE_MESSAGES,
} from "../src/telemetry/proto/definitions.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { encodeProtobuf, keyValues, nowNs, secretKeyOf } from "./helpers/telemetry.ts";

const SITE = "example.com";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const HOUR_MS = 3_600_000;

type App = ReturnType<typeof buildApp>;

/** An object store in memory: replays need one configured, source maps write to it. */
function memoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key, body) => {
      objects.set(key, body);
    },
    get: async (key) => objects.get(key) ?? null,
    delete: async (keys) => {
      for (const key of keys) objects.delete(key);
    },
    deletePrefix: async (prefix) => {
      let deleted = 0;
      for (const key of objects.keys()) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
    close: () => undefined,
  };
}

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
/** The dashboard app's counters, shared by every app these tests make. */
let activity: IngestActivity;
const store = memoryStore();
const otherApps: App[] = [];
let unreachableClickHouse: ClickHouseClient;

beforeAll(async () => {
  dashboard = await signedInDashboard({
    objectStore: store,
    ingestActivity: (db) => {
      // A flush only when a test asks for one.
      activity = new IngestActivity(db, { flushIntervalMs: 3_600_000 });
      return activity;
    },
  });
  unreachableClickHouse = createClickHouse(
    { ...loadConfig().clickhouse, url: "http://127.0.0.1:1" },
    { database: dashboard.clickhouseDatabase },
  );
});

afterAll(async () => {
  await Promise.all(otherApps.map((app) => app.close()));
  await unreachableClickHouse?.close();
  await dashboard?.close();
});

/** Another app on the test database, counting into the same counters. */
function appWith(options: Partial<AppOptions>): App {
  const app = buildApp({
    db: dashboard.db,
    objectStore: store,
    ingestActivity: activity,
    ...options,
    collection: { clickhouse: dashboard.reader.client, ...options.collection },
    telemetry: { clickhouse: dashboard.reader.client, ...options.telemetry },
  });
  otherApps.push(app);
  return app;
}

/** An app whose ClickHouse cannot be reached. */
let brokenApp: App | undefined;
function broken(): App {
  brokenApp ??= appWith({
    collection: { clickhouse: unreachableClickHouse },
    telemetry: { clickhouse: unreachableClickHouse },
  });
  return brokenApp;
}

async function newProject(values: Record<string, unknown> = {}) {
  const project = await insertProject(dashboard.db, {
    name: "Activity",
    allowed_hostnames: [SITE],
    ...values,
  });
  return {
    id: project.id,
    publicKey: project.public_key,
    secretKey: await secretKeyOf(dashboard.db, project.id),
  };
}

/** Text in code-unit order, as the flush sorts its keys. */
const textOrder = (a: string | undefined, b: string | undefined) =>
  (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

type Counts = Record<string, { count: number; items: number }>;

/**
 * Flushes the counters, then reads the project's rows as "source outcome":
 * requests and items, every hour together (a test may cross one).
 */
async function countsOf(projectId: string): Promise<Counts> {
  await activity.flush();
  const rows = await dashboard.db
    .selectFrom("ingest_activity")
    .select(["source", "outcome", "count", "items"])
    .where("project_id", "=", projectId)
    .execute();
  const counts: Counts = {};
  for (const row of rows) {
    const key = `${row.source} ${row.outcome}`;
    const sum = counts[key] ?? { count: 0, items: 0 };
    counts[key] = { count: sum.count + Number(row.count), items: sum.items + Number(row.items) };
  }
  return counts;
}

const counted = (count: number, items = 0) => ({ count, items });

function pageview(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: "pageview",
    occurredAt: Date.now() - 1000,
    url: `https://${SITE}/pricing`,
    ...overrides,
  };
}

function sendEvents(
  key: string,
  events: unknown[],
  {
    app = dashboard.app,
    headers = {},
    remoteAddress = "203.0.113.10",
  }: { app?: App; headers?: Record<string, string>; remoteAddress?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/events",
    headers: { "content-type": "text/plain", "user-agent": CHROME, ...headers },
    payload: JSON.stringify({ v: 1, key, sentAt: Date.now(), events }),
    remoteAddress,
  });
}

describe("browser events", () => {
  test("counts a batch once in each source it carries, with each source's events", async () => {
    const project = await newProject();
    const response = await sendEvents(project.publicKey, [
      pageview(),
      pageview({ name: "signup" }),
      pageview({ name: "error", error: { type: "TypeError", message: "x is undefined" } }),
      pageview({ name: "vitals", properties: { lcp: 1200 } }),
      // Two days before it was sent: dropped.
      pageview({ occurredAt: Date.now() - 48 * HOUR_MS }),
    ]);
    expect(response.statusCode).toBe(202);
    expect(await countsOf(project.id)).toEqual({
      "browser_events accepted": counted(1, 2),
      "browser_events filtered_too_old": counted(1, 1),
      "errors accepted": counted(1, 1),
      "web_vitals accepted": counted(1, 1),
    });
  });

  test("counts refusals and filters once the project is known", async () => {
    const project = await newProject({
      blocked_addresses: ["198.51.100.7"],
      blocked_referrers: ["spam.example"],
    });
    const key = project.publicKey;
    const statuses = [
      // The page's site is not in Allowed sites: by Origin, and by the event's URL.
      await sendEvents(key, [pageview()], { headers: { origin: "https://other.example" } }),
      await sendEvents(key, [pageview({ url: "https://other.example/" })]),
      // Invalid once the key is read.
      await sendEvents(key, [pageview({ name: "engagement" })]),
      // A bot, a blocked address, and referrer spam: filtered, per event.
      await sendEvents(key, [pageview(), pageview()], { headers: { "user-agent": "curl/8.0" } }),
      await sendEvents(key, [pageview()], { remoteAddress: "198.51.100.7" }),
      await sendEvents(key, [pageview({ referrer: "https://spam.example/" })]),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([403, 403, 400, 202, 202, 202]);
    expect(await countsOf(project.id)).toEqual({
      "browser_events refused_origin": counted(2),
      "browser_events refused_invalid": counted(1),
      "browser_events filtered_bot": counted(1, 2),
      "browser_events filtered_spam": counted(2, 2),
    });
  });

  test("counts nothing for a request whose project is not known", async () => {
    const before = await activity.flush().then(() =>
      dashboard.db
        .selectFrom("ingest_activity")
        .select((eb) => eb.fn.countAll<string>().as("rows"))
        .executeTakeFirstOrThrow(),
    );
    const statuses = [
      await sendEvents(`pk_${"0".repeat(32)}`, [pageview()]),
      await dashboard.app.inject({
        method: "POST",
        url: "/api/events",
        headers: { "content-type": "text/plain", "user-agent": CHROME },
        payload: "{not json",
      }),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([403, 400]);
    expect(activity.size).toBe(0);
    const after = await dashboard.db
      .selectFrom("ingest_activity")
      .select((eb) => eb.fn.countAll<string>().as("rows"))
      .executeTakeFirstOrThrow();
    expect(after.rows).toBe(before.rows);
  });

  test("counts a visitor past its daily cap as spam, per event", async () => {
    const project = await newProject();
    const capped = appWith({ collection: { visitorCap: 1 } });
    const response = await sendEvents(project.publicKey, [pageview(), pageview(), pageview()], {
      app: capped,
    });
    expect(response.json()).toMatchObject({ stored: 1, capped: 2 });
    expect(await countsOf(project.id)).toEqual({
      "browser_events accepted": counted(1, 1),
      "browser_events filtered_spam": counted(1, 2),
    });
  });

  test("tells the project's rate limit from the instance's", async () => {
    const full = Array.from({ length: 50 }, () => pageview());
    const project = await newProject();
    const perProject = appWith({
      collection: { projectLimit: { capacity: 50, refillPerSecond: 0.001 } },
    });
    await sendEvents(project.publicKey, full, { app: perProject });
    expect((await sendEvents(project.publicKey, full, { app: perProject })).statusCode).toBe(429);

    const first = await newProject();
    const second = await newProject();
    const perInstance = appWith({
      collection: { instanceLimit: { capacity: 50, refillPerSecond: 0.001 } },
    });
    await sendEvents(first.publicKey, full, { app: perInstance });
    expect((await sendEvents(second.publicKey, full, { app: perInstance })).statusCode).toBe(429);

    expect(await countsOf(project.id)).toEqual({
      "browser_events accepted": counted(1, 50),
      "browser_events refused_rate_limited": counted(1),
    });
    expect(await countsOf(second.id)).toEqual({ "browser_events refused_volume": counted(1) });
  });

  test("counts a 503 while ClickHouse cannot store the events", async () => {
    const project = await newProject();
    expect((await sendEvents(project.publicKey, [pageview()], { app: broken() })).statusCode).toBe(
      503,
    );
    expect(await countsOf(project.id)).toEqual({
      "browser_events refused_unavailable": counted(1),
    });
  });
});

const serverEvent = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  name: "payment",
  occurredAt: Date.now() - 1000,
  userId: "user-1",
  ...overrides,
});
const sendServerEvents = (secretKey: string, events: unknown[], app = dashboard.app) =>
  app.inject({
    method: "POST",
    url: "/api/server-events",
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify({ v: 1, events }),
  });

describe("server events", () => {
  test("counts stored, too old, invalid, and unavailable", async () => {
    const project = await newProject();
    const statuses = [
      await sendServerEvents(project.secretKey, [
        serverEvent(),
        serverEvent(),
        serverEvent({ occurredAt: Date.now() - 48 * HOUR_MS }),
      ]),
      await sendServerEvents(project.secretKey, [
        serverEvent({ occurredAt: Date.now() + HOUR_MS }),
      ]),
      await sendServerEvents(project.secretKey, [serverEvent()], broken()),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([202, 400, 503]);
    expect(await countsOf(project.id)).toEqual({
      "server_events accepted": counted(1, 2),
      "server_events filtered_too_old": counted(1, 1),
      "server_events refused_invalid": counted(1),
      "server_events refused_unavailable": counted(1),
    });
  });

  test("counts the project's rate limit", async () => {
    const project = await newProject();
    const limited = appWith({
      collection: { projectLimit: { capacity: 50, refillPerSecond: 0.001 } },
    });
    const full = Array.from({ length: 50 }, () => serverEvent());
    await sendServerEvents(project.secretKey, full, limited);
    expect((await sendServerEvents(project.secretKey, full, limited)).statusCode).toBe(429);
    expect(await countsOf(project.id)).toMatchObject({
      "server_events refused_rate_limited": counted(1),
    });
  });
});

const sendChunk = (
  key: string,
  body: Buffer,
  {
    app = dashboard.app,
    headers = {},
    seq = 0,
  }: { app?: App; headers?: Record<string, string>; seq?: number } = {},
) =>
  app.inject({
    method: "POST",
    url: `/api/replays?key=${key}&replay=${randomUUID()}&seq=${seq}&last=0&cut=0`,
    headers: { "content-type": "text/plain", "user-agent": CHROME, ...headers },
    payload: body,
  });
const chunk = () => gzipSync('[{"type":4,"data":{}}]');

describe("replays", () => {
  test("counts chunks stored, refused, and filtered", async () => {
    const project = await newProject({ replay_mode: "errors" });
    const off = await newProject();
    const statuses = [
      await sendChunk(project.publicKey, chunk()),
      await sendChunk(project.publicKey, chunk(), { headers: { origin: "https://other.example" } }),
      await sendChunk(project.publicKey, Buffer.from("not gzip")),
      await sendChunk(project.publicKey, chunk(), { headers: { "user-agent": "curl/8.0" } }),
      await sendChunk(off.publicKey, chunk()),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([202, 403, 400, 202, 403]);
    expect(await countsOf(project.id)).toEqual({
      "replays accepted": counted(1, 1),
      "replays refused_origin": counted(1),
      "replays refused_invalid": counted(1),
      "replays filtered_bot": counted(1, 1),
    });
    expect(await countsOf(off.id)).toEqual({ "replays refused_disabled": counted(1) });
  });

  test("counts a full storage budget as volume", async () => {
    const project = await newProject({ replay_mode: "errors" });
    const full = appWith({ replays: { limitBytes: 1 } });
    expect((await sendChunk(project.publicKey, chunk(), { app: full })).statusCode).toBe(403);
    expect(await countsOf(project.id)).toEqual({ "replays refused_volume": counted(1) });
  });
});

const click = () => ({
  id: randomUUID(),
  type: "click",
  at: Date.now() - 2000,
  page: 0,
  element: "section>a",
  x: 0.25,
  y: 0.5,
  vw: 1280,
  vh: 800,
  ph: 3200,
  device: "desktop",
});
const sendHeatmap = (key: string, records: unknown[], app = dashboard.app) =>
  app.inject({
    method: "POST",
    url: "/api/heatmaps",
    headers: { "content-type": "text/plain", "user-agent": CHROME },
    payload: JSON.stringify({
      v: 1,
      key,
      sentAt: Date.now(),
      pages: [{ url: `https://${SITE}/` }],
      records,
    }),
    remoteAddress: "203.0.113.20",
  });

describe("heatmaps", () => {
  test("counts records stored, invalid, off, and unavailable", async () => {
    const project = await newProject({ heatmaps: true });
    const off = await newProject();
    const statuses = [
      await sendHeatmap(project.publicKey, [click(), click()]),
      await sendHeatmap(project.publicKey, [{ ...click(), device: "mobile" }]),
      await sendHeatmap(project.publicKey, [click()], broken()),
      await sendHeatmap(off.publicKey, [click()]),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([202, 400, 503, 403]);
    expect(await countsOf(project.id)).toEqual({
      "heatmaps accepted": counted(1, 2),
      "heatmaps refused_invalid": counted(1),
      "heatmaps refused_unavailable": counted(1),
    });
    expect(await countsOf(off.id)).toEqual({ "heatmaps refused_disabled": counted(1) });
  });
});

const RESOURCE = { attributes: keyValues({ "service.name": "checkout" }) };
const hex = (bytes: number) => randomBytes(bytes);
const span = (events: object[] = []) => {
  const start = nowNs(-5000);
  return {
    traceId: hex(16),
    spanId: hex(8),
    name: "POST /pay",
    kind: 2,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 250_000_000n),
    events,
  };
};
const exception = {
  name: "exception",
  timeUnixNano: String(nowNs(-4000)),
  attributes: keyValues({ "exception.type": "IllegalStateException", "exception.message": "no" }),
};
const traces = (spans: object[]) =>
  encodeProtobuf(TRACE_MESSAGES, {
    resourceSpans: [{ resource: RESOURCE, scopeSpans: [{ scope: { name: "http" }, spans }] }],
  });
const logs = (count: number) =>
  encodeProtobuf(LOGS_MESSAGES, {
    resourceLogs: [
      {
        resource: RESOURCE,
        scopeLogs: [
          {
            scope: { name: "pino" },
            logRecords: Array.from({ length: count }, () => ({
              timeUnixNano: String(nowNs(-1000)),
              severityNumber: 9,
              body: { stringValue: "paid" },
            })),
          },
        ],
      },
    ],
  });
const metrics = () =>
  encodeProtobuf(METRICS_MESSAGES, {
    resourceMetrics: [
      {
        resource: RESOURCE,
        scopeMetrics: [
          {
            scope: { name: "meter" },
            metrics: [
              {
                name: "queue.depth",
                gauge: {
                  dataPoints: [
                    { timeUnixNano: String(nowNs(-1000)), asDouble: 3.5 },
                    { timeUnixNano: String(nowNs(-2000)), asDouble: 2 },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
const post = (path: string, body: Buffer | string, secretKey: string, app = dashboard.app) =>
  app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${secretKey}` },
    payload: body,
  });

describe("telemetry", () => {
  test("counts spans, log records, and data points, and the errors the spans held", async () => {
    const project = await newProject();
    const statuses = [
      await post("/v1/traces", traces([span([exception]), span()]), project.secretKey),
      await post("/v1/logs", logs(3), project.secretKey),
      await post("/v1/metrics", metrics(), project.secretKey),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([200, 200, 200]);
    expect(await countsOf(project.id)).toEqual({
      "traces accepted": counted(1, 2),
      "errors accepted": counted(1, 1),
      "logs accepted": counted(1, 3),
      "metrics accepted": counted(1, 2),
    });
  });

  test("counts malformed bodies, the project's rate limit, and unavailable", async () => {
    const project = await newProject();
    const limited = appWith({
      telemetry: { projectLimit: { capacity: 5, refillPerSecond: 0.001 } },
    });
    const statuses = [
      await post("/v1/traces", Buffer.from([0xff, 0xff, 0xff]), project.secretKey),
      await post("/v1/logs", logs(2), project.secretKey, broken()),
      await post("/v1/metrics", metrics(), project.secretKey, limited),
      await post("/v1/metrics", metrics(), project.secretKey, limited),
      await post("/v1/metrics", metrics(), project.secretKey, limited),
    ].map((response) => response.statusCode);
    expect(statuses.slice(0, 2)).toEqual([400, 503]);
    expect(statuses.slice(2)).toContain(429);
    const counts = await countsOf(project.id);
    expect(counts).toMatchObject({
      "traces refused_invalid": counted(1),
      "logs refused_unavailable": counted(1),
      "metrics refused_rate_limited": counted(statuses.filter((status) => status === 429).length),
    });
  });

  test("does not count a request refused before its key is read", async () => {
    const project = await newProject();
    const response = await dashboard.app.inject({
      method: "POST",
      url: "/v1/logs",
      headers: { "content-type": "text/plain", authorization: `Bearer ${project.secretKey}` },
      payload: "x",
    });
    // An encoding OTLP does not use is refused before the key: not counted.
    expect(response.statusCode).toBe(415);
    expect(await countsOf(project.id)).toEqual({});
  });
});

const call = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  occurredAt: Date.now() - 60_000,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputTokens: 10,
  outputTokens: 5,
  durationMs: 120,
  ...overrides,
});
const sendAiCalls = (secretKey: string, body: unknown, app = dashboard.app) =>
  app.inject({
    method: "POST",
    url: "/api/ai-calls",
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify(body),
  });

describe("AI calls", () => {
  test("counts calls stored, too old, invalid by schema, and unavailable", async () => {
    const project = await newProject();
    const statuses = [
      await sendAiCalls(project.secretKey, {
        v: 1,
        calls: [call(), call(), call({ occurredAt: Date.now() - 48 * HOUR_MS })],
      }),
      // The schema refuses it, after the key was read.
      await sendAiCalls(project.secretKey, { v: 1, calls: [{ id: randomUUID() }] }),
      await sendAiCalls(project.secretKey, { v: 1, calls: [call()] }, broken()),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([202, 400, 503]);
    expect(await countsOf(project.id)).toEqual({
      "ai_calls accepted": counted(1, 2),
      "ai_calls filtered_too_old": counted(1, 1),
      "ai_calls refused_invalid": counted(1),
      "ai_calls refused_unavailable": counted(1),
    });
  });
});

const MAP = JSON.stringify({
  version: 3,
  sources: ["src/cart.ts"],
  names: [],
  mappings: "AAAA",
});
const upload = (
  secretKey: string,
  body: string,
  { app = dashboard.app, path = "/assets/index.js" }: { app?: App; path?: string } = {},
) =>
  app.inject({
    method: "PUT",
    url: `/api/source-maps?release=1.0.0&path=${encodeURIComponent(path)}`,
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: body,
  });

describe("source maps", () => {
  test("counts maps stored, invalid, refused by the schema, and over the budget", async () => {
    const project = await newProject();
    const full = appWith({ sourceMaps: { limitBytes: 1 } });
    const statuses = [
      await upload(project.secretKey, MAP),
      await upload(project.secretKey, '{"version":2}'),
      await upload(project.secretKey, MAP, { path: "x".repeat(5000) }),
      await upload(project.secretKey, MAP, { app: full, path: "/assets/other.js" }),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([201, 400, 400, 409]);
    expect(await countsOf(project.id)).toEqual({
      "source_maps accepted": counted(1, 1),
      "source_maps refused_invalid": counted(2),
      "source_maps refused_volume": counted(1),
    });
  });
});

/** A database that fails while `failing` is set, the test's otherwise. */
function switchable(db: Kysely<Database>) {
  const unreachable = createDatabase({
    connectionString: "postgres://unused@127.0.0.1:1/unused",
  });
  const state = { failing: false };
  const proxy = new Proxy(db, {
    get(target, property) {
      const real = state.failing ? unreachable : target;
      const value: unknown = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  return { db: proxy, state, close: () => unreachable.destroy() };
}

const rowsOf = async (projectId: string) =>
  dashboard.db
    .selectFrom("ingest_activity")
    .select(["source", "outcome", "count", "items", "last_at"])
    .where("project_id", "=", projectId)
    .orderBy("source")
    .execute();

describe("the counters and their flush", () => {
  test("adds each flush to what is stored, as several processes would", async () => {
    const project = await newProject();
    let now = Date.now();
    const first = new IngestActivity(dashboard.db, { now: () => now });
    const second = new IngestActivity(dashboard.db, { now: () => now });
    first.add(project.id, "logs", "accepted", 10);
    await first.flush();
    now += 1000;
    first.add(project.id, "logs", "accepted", 5);
    second.add(project.id, "logs", "accepted", 1);
    await Promise.all([first.flush(), second.flush()]);
    const [row] = await rowsOf(project.id);
    expect(row).toMatchObject({ count: "3", items: "16" });
    expect(row?.last_at.getTime()).toBe(now);
  });

  test("keeps a failed flush's counts and adds them to the next", async () => {
    const project = await newProject();
    const db = switchable(dashboard.db);
    try {
      const counters = new IngestActivity(db.db);
      counters.add(project.id, "traces", "accepted", 4);
      db.state.failing = true;
      await expect(counters.flush()).rejects.toBeInstanceOf(Error);
      expect(counters.size).toBe(1);
      counters.add(project.id, "traces", "accepted", 1);
      db.state.failing = false;
      await counters.flush();
      expect(counters.size).toBe(0);
      expect(await rowsOf(project.id)).toMatchObject([{ count: "2", items: "5" }]);
    } finally {
      await db.close();
    }
  });

  test("drops new keys past the cap, and warns once a flush", async () => {
    const project = await newProject();
    const warnings: Record<string, unknown>[] = [];
    const counters = new IngestActivity(dashboard.db, {
      maxKeys: 2,
      warn: (_message, fields) => warnings.push(fields),
    });
    counters.add(project.id, "logs", "accepted");
    counters.add(project.id, "traces", "accepted");
    counters.add(project.id, "metrics", "accepted");
    counters.add(project.id, "errors", "accepted");
    // A key already held still counts.
    counters.add(project.id, "logs", "accepted");
    expect(counters.size).toBe(2);
    await counters.flush();
    expect(warnings).toEqual([{ dropped: 2, maxKeys: 2 }]);
    expect((await rowsOf(project.id)).map((row) => [row.source, row.count])).toEqual([
      ["logs", "2"],
      ["traces", "1"],
    ]);
    await counters.flush();
    expect(warnings).toHaveLength(1);
    expect(ACTIVITY_MAX_KEYS).toBe(20_000);
  });

  test("writes the last counts when the app closes, before closeAfter closes the database", async () => {
    const project = await newProject();
    // The app's own pool, closed by closeAfter, as server.ts closes its database.
    const appDb = createDatabase({
      connectionString: loadConfig().databaseUrl,
      maxConnections: 2,
      schema: dashboard.schema,
    });
    const order: string[] = [];
    const app = buildApp({
      db: appDb,
      collection: { clickhouse: dashboard.reader.client },
      closeAfter: async () => {
        order.push("closeAfter");
        await appDb.destroy();
      },
    });
    // A hook added after buildApp runs before the app's own (last added, first run).
    app.addHook("onClose", async () => {
      order.push("caller's hook");
    });
    expect((await sendEvents(project.publicKey, [pageview()], { app })).statusCode).toBe(202);
    expect(await rowsOf(project.id)).toEqual([]);
    await app.close();
    expect(order).toEqual(["caller's hook", "closeAfter"]);
    expect(await rowsOf(project.id)).toMatchObject([{ source: "browser_events", count: "1" }]);
  });

  test("keeps at most the cap through failed flushes, and drops hours past the 7 days", async () => {
    const project = await newProject();
    const db = switchable(dashboard.db);
    try {
      let now = Date.now();
      const warnings: Record<string, unknown>[] = [];
      const counters = new IngestActivity(db.db, {
        now: () => now,
        maxKeys: 2,
        warn: (_message, fields) => warnings.push(fields),
      });
      db.state.failing = true;
      counters.add(project.id, "logs", "accepted");
      counters.add(project.id, "traces", "accepted");
      await expect(counters.flush()).rejects.toBeInstanceOf(Error);
      // The next hour: new keys while the kept ones wait.
      now += HOUR_MS;
      counters.add(project.id, "metrics", "accepted");
      counters.add(project.id, "errors", "accepted");
      await expect(counters.flush()).rejects.toBeInstanceOf(Error);
      expect(counters.size).toBe(2);
      // Eight days on, every kept hour is past the 7 days.
      now += 8 * 24 * HOUR_MS;
      await expect(counters.flush()).rejects.toBeInstanceOf(Error);
      expect(counters.size).toBe(0);
      db.state.failing = false;
      await counters.flush();
      expect(warnings.map((fields) => fields.dropped)).toEqual([2, 2]);
      expect(await rowsOf(project.id)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  test("writes rows in key order, so processes lock them in one order", async () => {
    const statements: string[] = [];
    const project = await newProject();
    const other = await newProject();
    const recording = new Proxy(dashboard.db, {
      get(target, property) {
        if (property === "getExecutor") {
          return () => {
            const executor = target.getExecutor();
            return new Proxy(executor, {
              get(inner, name) {
                const value: unknown = Reflect.get(inner, name, inner);
                if (name !== "executeQuery" || typeof value !== "function") {
                  return typeof value === "function" ? value.bind(inner) : value;
                }
                return (
                  query: { sql: string; parameters: readonly unknown[] },
                  ...rest: unknown[]
                ) => {
                  statements.push(JSON.stringify(query.parameters));
                  return (value as (...args: unknown[]) => unknown).call(inner, query, ...rest);
                };
              },
            });
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counters = new IngestActivity(recording);
    const [first, second] = [project.id, other.id].toSorted(textOrder);
    counters.add(second ?? "", "traces", "accepted");
    counters.add(first ?? "", "traces", "accepted");
    counters.add(first ?? "", "logs", "refused_volume");
    counters.add(first ?? "", "logs", "accepted");
    await counters.flush();
    const parameters = JSON.parse(statements[0] ?? "[]") as unknown[];
    const keys = [0, 7, 14, 21].map((at) =>
      [parameters[at], parameters[at + 2], parameters[at + 3]].join(" "),
    );
    expect(keys).toEqual([
      `${first} logs accepted`,
      `${first} logs refused_volume`,
      `${first} traces accepted`,
      `${second} traces accepted`,
    ]);
  });

  test("skips a project deleted before the flush", async () => {
    const project = await newProject();
    const kept = await newProject();
    const counters = new IngestActivity(dashboard.db);
    counters.add(project.id, "logs", "accepted");
    counters.add(kept.id, "logs", "accepted");
    await dashboard.db.deleteFrom("projects").where("id", "=", project.id).execute();
    await counters.flush();
    expect(await rowsOf(kept.id)).toHaveLength(1);
  });

  test("does no database work when counting", () => {
    const untouchable = new Proxy({} as Kysely<Database>, {
      get() {
        throw new Error("the database was touched");
      },
    });
    const counters = new IngestActivity(untouchable);
    for (let index = 0; index < 1000; index += 1) {
      counters.add(randomUUID(), "browser_events", "accepted", 1);
    }
    expect(counters.size).toBe(1000);
  });
});

/** The current hour's start, and `hours` before it. */
const hourAgo = (hours: number) => {
  const now = Date.now();
  return new Date(now - (now % HOUR_MS) - hours * HOUR_MS);
};
async function insertCount(
  projectId: string,
  hoursBefore: number,
  count: number,
  outcome: IngestOutcome = "accepted",
  source: IngestSource = "logs",
) {
  await dashboard.db
    .insertInto("ingest_activity")
    .values({
      project_id: projectId,
      hour: hourAgo(hoursBefore),
      source,
      outcome,
      count,
      items: count * 10,
      last_at: hourAgo(hoursBefore),
    })
    .execute();
}
const get = (projectId: string, cookie = dashboard.cookie) =>
  dashboard.app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/ingest-activity`,
    headers: { cookie },
  });

describe("GET /api/projects/:id/ingest-activity", () => {
  test("sums this hour, and the 24 hours and 7 days that end with it, in whole hours", async () => {
    const project = await newProject();
    await insertCount(project.id, 0, 1);
    await insertCount(project.id, 1, 2);
    await insertCount(project.id, 23, 4);
    await insertCount(project.id, 24, 8);
    await insertCount(project.id, 167, 16);
    // Past the 7 days.
    await insertCount(project.id, 168, 32);
    await insertCount(project.id, 2, 5, "refused_origin");
    const response = await get(project.id);
    expect(response.statusCode).toBe(200);
    const { since, sources } = response.json<{
      since: Record<string, string>;
      sources: { source: string }[];
    }>();
    expect(since).toEqual({
      hour: hourAgo(0).toISOString(),
      day: hourAgo(23).toISOString(),
      week: hourAgo(167).toISOString(),
    });
    expect(sources.map((source) => source.source)).toEqual([
      "browser_events",
      "server_events",
      "errors",
      "web_vitals",
      "replays",
      "heatmaps",
      "traces",
      "logs",
      "metrics",
      "ai_calls",
      "source_maps",
    ]);
    expect(sources.find((source) => source.source === "logs")).toEqual({
      source: "logs",
      lastAcceptedAt: hourAgo(0).toISOString(),
      outcomes: {
        accepted: {
          hour: { count: 1, items: 10 },
          day: { count: 7, items: 70 },
          week: { count: 31, items: 310 },
          lastAt: hourAgo(0).toISOString(),
        },
        refused_origin: {
          hour: { count: 0, items: 0 },
          day: { count: 5, items: 50 },
          week: { count: 5, items: 50 },
          lastAt: hourAgo(2).toISOString(),
        },
      },
    });
    expect(sources.find((source) => source.source === "traces")).toEqual({
      source: "traces",
      lastAcceptedAt: null,
      outcomes: {},
    });
  });

  test("answers the owner and admins, and refuses a member", async () => {
    const project = await newProject();
    const admin = await signedInUser(dashboard, {
      name: "Admin",
      email: "activity-admin@example.com",
      role: "admin",
    });
    const member = await signedInUser(dashboard, {
      name: "Member",
      email: "activity-member@example.com",
      grants: {
        projects: "all",
        areas: { web_analytics: "view", errors: "view", monitoring: "view" },
      },
    });
    expect((await get(project.id)).statusCode).toBe(200);
    expect((await get(project.id, admin.cookie)).statusCode).toBe(200);
    expect((await get(project.id, member.cookie)).statusCode).toBe(403);
    expect(
      (
        await dashboard.app.inject({
          method: "GET",
          url: `/api/projects/${project.id}/ingest-activity`,
          headers: { origin: PUBLIC_URL },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("the worker's cleanup", () => {
  test("deletes the hours before the 7 days' window, and only those", async () => {
    const project = await newProject();
    const now = new Date();
    const at = (hoursBefore: number) =>
      new Date(now.getTime() - (now.getTime() % HOUR_MS) - hoursBefore * HOUR_MS);
    for (const hours of [168, 167, 2]) {
      await dashboard.db
        .insertInto("ingest_activity")
        .values({
          project_id: project.id,
          hour: at(hours),
          source: "logs",
          outcome: "accepted",
          count: 1,
          items: 1,
          last_at: at(hours),
        })
        .execute();
    }
    expect(await pruneIngestActivity(dashboard.db, now)).toBeGreaterThanOrEqual(1);
    const left = await dashboard.db
      .selectFrom("ingest_activity")
      .select("hour")
      .where("project_id", "=", project.id)
      .orderBy("hour")
      .execute();
    expect(left.map((row) => row.hour.getTime())).toEqual([at(167).getTime(), at(2).getTime()]);
  });
});

const row = (
  projectId: string,
  overrides: { hour?: string; source?: string; outcome?: string; count?: number } = {},
) =>
  sql`insert into ingest_activity (project_id, hour, source, outcome, count, last_at)
      values (${projectId}, ${overrides.hour ?? "2026-11-23T10:00:00Z"}::timestamptz,
              ${overrides.source ?? "logs"}, ${overrides.outcome ?? "accepted"},
              ${overrides.count ?? 1}, now())`;

describe("migration 0024_ingest_activity", () => {
  test("allows only the listed sources and outcomes, whole hours, and counts of 0 or more", async () => {
    const project = await newProject();
    await row(project.id).execute(dashboard.db);
    for (const bad of [
      { source: "emails" },
      { outcome: "lost" },
      { hour: "2026-11-23T10:30:00Z" },
      { count: -1 },
    ]) {
      await expect(row(project.id, bad).execute(dashboard.db)).rejects.toThrow(/check constraint/);
    }
  });

  test("its CHECK lists are the code's sources and outcomes", async () => {
    const { rows } = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'ingest_activity'::regclass and contype = 'c'`.execute(dashboard.db);
    const listed = (column: string) => {
      const definition = rows.find((one) => one.definition.includes(`(${column} = ANY`));
      return [...(definition?.definition.matchAll(/'([a-z_]+)'::text/g) ?? [])]
        .map((match) => match[1])
        .toSorted(textOrder);
    };
    expect(listed("source")).toEqual([...INGEST_SOURCES].toSorted(textOrder));
    expect(listed("outcome")).toEqual([...INGEST_OUTCOMES].toSorted(textOrder));
  });

  test("deletes a project's rows with it", async () => {
    const project = await newProject();
    await row(project.id).execute(dashboard.db);
    await dashboard.db.deleteFrom("projects").where("id", "=", project.id).execute();
    const left = await dashboard.db
      .selectFrom("ingest_activity")
      .select("project_id")
      .where("project_id", "=", project.id)
      .execute();
    expect(left).toEqual([]);
  });
});
