import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createClickHouse, identifier } from "../src/clickhouse/clickhouse.ts";
import { migrateClickHouse } from "../src/clickhouse/migrate.ts";
import { CLICKHOUSE_MIGRATIONS } from "../src/clickhouse/migrations.ts";
import { loadConfig } from "../src/config.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";
import { testName } from "./helpers/test-names.ts";

/** Check database reports against OTLP spans and rows too large for OTLP. */

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

const MS = 1_000_000n;
/** Yesterday, in UTC (the instance's timezone): a whole day, so 288 buckets of 5 minutes. */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const DAY = `from=${YESTERDAY}&to=${YESTERDAY}`;
const at = (time: string) => BigInt(Date.parse(`${YESTERDAY}T${time}Z`)) * MS;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

interface SpanOptions {
  kind?: number;
  failed?: boolean;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

function span(
  name: string,
  time: string,
  durationMs: number,
  attributes: Record<string, string | number>,
  {
    kind = 3,
    failed = false,
    traceId = hex(16),
    spanId = hex(8),
    parentSpanId = "",
  }: SpanOptions = {},
) {
  const start = at(time);
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + BigInt(durationMs) * MS),
    attributes: keyValues(attributes),
    status: { code: failed ? 2 : 0 },
  };
}

async function send(
  secretKey: string,
  services: Record<string, object[]>,
  environment?: string,
): Promise<void> {
  const response = await dashboard.app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify({
      resourceSpans: Object.entries(services).map(([service, spans]) => ({
        resource: {
          attributes: keyValues({
            "service.name": service,
            ...(environment === undefined ? {} : { "deployment.environment.name": environment }),
          }),
        },
        scopeSpans: [{ spans }],
      })),
    }),
  });
  expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body: {} });
}

/** Spans written straight into ClickHouse, for sizes OTLP's limits would refuse. */
async function insertCalls(
  projectId: string,
  calls: { time: string; durationMs: number; attributes: Record<string, string>; name?: string }[],
): Promise<void> {
  await dashboard.reader.client.insert({
    table: "spans",
    format: "JSONEachRow",
    values: calls.map((call) => ({
      project_id: projectId,
      timestamp: `${YESTERDAY} ${call.time}`,
      id: hex(24),
      trace_id: hex(16),
      span_id: hex(8),
      parent_span_id: "",
      name: call.name ?? "query",
      kind: "client",
      duration_ns: String(BigInt(call.durationMs) * MS),
      status_code: "unset",
      status_message: "",
      service: "bulk",
      release: "",
      environment: "production",
      resource_attributes: {},
      attributes: call.attributes,
      events: "[]",
      links: "[]",
      scope_name: "",
      scope_version: "",
    })),
  });
}

function get(projectId: string, path: string, { signedIn = true } = {}) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: signedIn ? { cookie: dashboard.cookie } : {},
  });
}

async function getJson(projectId: string, path: string) {
  const response = await get(projectId, path);
  expect({ path, status: response.statusCode, body: response.json() }).toMatchObject({
    path,
    status: 200,
  });
  return response.json();
}

interface Stats {
  calls: number;
  failed: number;
  totalUs: number;
  perSecond: number | null;
  p50Us: number;
  p95Us: number;
  p99Us: number;
  services: string[];
  serviceCount: number;
}
interface Shape extends Stats {
  id: string;
  kind: string;
  shape: string;
}
interface Database extends Stats {
  system: string;
  database: string;
  shapeCount: number;
  shapes: Shape[];
}
interface List {
  databases: Database[];
  truncated: boolean;
  received: boolean;
  seconds: number;
  sort: string;
  environments: string[];
}
interface Detail {
  id: string;
  shape: { kind: string; text: string; system: string; database: string } | null;
  stepSeconds: number;
  buckets: number;
  totals: Stats;
  counts: { calls: number[]; failed: number[] };
  perSecond: (number | null)[];
  failedShare: (number | null)[];
  durations: Record<"p50Us" | "p95Us" | "p99Us", (number | null)[]>;
  services: (Omit<Stats, "services" | "serviceCount"> & { service: string })[];
  slowest: {
    traceId: string;
    spanId: string;
    start: string;
    startNs: string;
    durationUs: number;
    service: string;
    failed: boolean;
  }[];
  callers: { service: string; route: string | null; calls: number }[];
  sampled: number;
}

const list = async (projectId: string, query = DAY): Promise<List> =>
  getJson(projectId, `/databases?${query}`);
const detail = async (projectId: string, id: string, query = DAY): Promise<Detail> =>
  getJson(projectId, `/databases/shapes/${id}?${query}`);

const shapesOf = (database: Database | undefined) =>
  (database?.shapes ?? []).map((shape) => shape.shape);
const findDatabase = (data: List, system: string, database: string) =>
  data.databases.find((item) => item.system === system && item.database === database);

/** The shop: two services' requests and the database calls inside them. */
const SHOP = {
  id: "",
  secretKey: "",
  traces: { t1: hex(16), t2: hex(16), t3: hex(16) },
  spans: { a1: hex(8), a2: hex(8), a3: hex(8), legacy: hex(8) },
};

const ORDER_BY_ID = "SELECT * FROM orders WHERE id = ?";

beforeAll(async () => {
  dashboard = await signedInDashboard();
  const project = await insertProject(dashboard.db, { name: "Shop" });
  SHOP.id = project.id;
  SHOP.secretKey = await secretKeyOf(dashboard.db, project.id);
  const { t1, t2, t3 } = SHOP.traces;
  const NEW = { "db.system.name": "postgresql", "db.namespace": "shop" };
  const OLD = { "db.system": "postgresql", "db.name": "shop" };
  /*
   * postgresql / shop, yesterday:
   *
   *   A "SELECT * FROM orders WHERE id = ?": three calls, two generations of names
   *     a1 10:00:10, 10 ms, api, trace t1 (GET /orders/{id})   db.query.text
   *     a2 10:01:00, 30 ms, api, trace t2 (GET /orders/{id})   db.query.text, a comment, new lines
   *     a3 10:06:00, 50 ms, legacy, trace t3 (no request)       db.statement (older)
   *   B "SELECT * FROM orders WHERE id IN (?)": 10:02:00, 20 ms, failed, api
   *   C the summary "SELECT orders" (its text ignored): 10:07:00, 60 ms, api
   *
   * mongodb / catalog: "find products", from db.operation.name and
   * db.collection.name (10:03:00, 4 ms), and the older db.operation and
   * db.mongodb.collection (10:04:00, 6 ms): one shape.
   * redis / 0 (db.redis.database_index): no text, operation, or collection: its name, "GET".
   *
   * Not database calls: an HTTP client span, a server span with db.system,
   * a client span without a system, and one in staging.
   */
  await send(SHOP.secretKey, {
    api: [
      span(
        "GET /orders/{id}",
        "10:00:09",
        100,
        { "http.route": "/orders/{id}" },
        {
          kind: 2,
          traceId: t1,
        },
      ),
      span(
        "GET /orders/{id}",
        "10:00:59",
        100,
        { "http.route": "/orders/{id}" },
        {
          kind: 2,
          traceId: t2,
        },
      ),
      span(
        "SELECT orders",
        "10:00:10",
        10,
        {
          ...NEW,
          "db.query.text": "SELECT * FROM orders WHERE id = 42",
        },
        { traceId: t1, spanId: SHOP.spans.a1 },
      ),
      span(
        "SELECT orders",
        "10:01:00",
        30,
        {
          ...NEW,
          "db.query.text": "SELECT *\n  FROM orders /* by id */\n WHERE id = 7",
        },
        { traceId: t2, spanId: SHOP.spans.a2 },
      ),
      span(
        "SELECT orders",
        "10:02:00",
        20,
        {
          ...NEW,
          "db.query.text": "SELECT * FROM orders WHERE id IN (1, 2, 3)",
        },
        { failed: true },
      ),
      span("SELECT orders", "10:07:00", 60, {
        ...NEW,
        "db.query.summary": "SELECT orders",
        "db.query.text": "SELECT * FROM orders WHERE total > 100",
      }),
      span("find products", "10:03:00", 4, {
        "db.system.name": "mongodb",
        "db.namespace": "catalog",
        "db.operation.name": "find",
        "db.collection.name": "products",
      }),
      span("find", "10:04:00", 6, {
        "db.system": "mongodb",
        "db.name": "catalog",
        "db.operation": "find",
        "db.mongodb.collection": "products",
      }),
      span("GET", "10:05:00", 1, { "db.system": "redis", "db.redis.database_index": 0 }),
      span("GET https://example.com", "10:05:00", 80, { "http.request.method": "GET" }),
      span("SELECT 1", "10:05:00", 80, { ...NEW, "db.query.text": "SELECT 1" }, { kind: 2 }),
      span("SELECT 1", "10:05:00", 80, { "db.query.text": "SELECT 1" }),
    ],
    legacy: [
      span(
        "SELECT",
        "10:06:00",
        50,
        {
          ...OLD,
          "db.statement": "SELECT * FROM orders WHERE id = 99",
        },
        { traceId: t3, spanId: SHOP.spans.legacy },
      ),
    ],
  });
  await send(
    SHOP.secretKey,
    { api: [span("SELECT", "10:00:00", 999, { ...NEW, "db.query.text": "SELECT 2" })] },
    "staging",
  );
});

afterAll(async () => {
  await dashboard?.close();
});

const shapesSortedBy = async (sort: string) =>
  shapesOf(findDatabase(await list(SHOP.id, `${DAY}&sort=${sort}`), "postgresql", "shop"));

describe("GET /api/projects/:id/databases", () => {
  test("groups calls by system, database, and shape, under either generation of names", async () => {
    const data = await list(SHOP.id);
    expect(data.received).toBe(true);
    expect(data.truncated).toBe(false);
    expect(data.sort).toBe("time");
    expect(data.environments).toEqual(["production", "staging"]);
    // By time spent: postgresql 170 ms, mongodb 10 ms, redis 1 ms.
    expect(data.databases.map((item) => [item.system, item.database])).toEqual([
      ["postgresql", "shop"],
      ["mongodb", "catalog"],
      ["redis", "0"],
    ]);
    const shop = findDatabase(data, "postgresql", "shop");
    // A: 10 30 50 ms = 90 ms; C 60 ms; B 20 ms.
    expect(shop).toMatchObject({
      calls: 5,
      failed: 1,
      totalUs: 170_000,
      services: ["api", "legacy"],
      serviceCount: 2,
      shapeCount: 3,
    });
    expect(
      shop?.shapes.map(({ shape, kind, calls, failed, totalUs, services }) => ({
        shape,
        kind,
        calls,
        failed,
        totalUs,
        services,
      })),
    ).toEqual([
      {
        shape: ORDER_BY_ID,
        kind: "query",
        calls: 3,
        failed: 0,
        totalUs: 90_000,
        services: ["api", "legacy"],
      },
      {
        shape: "SELECT orders",
        kind: "summary",
        calls: 1,
        failed: 0,
        totalUs: 60_000,
        services: ["api"],
      },
      {
        shape: "SELECT * FROM orders WHERE id IN (?)",
        kind: "query",
        calls: 1,
        failed: 1,
        totalUs: 20_000,
        services: ["api"],
      },
    ]);
    // A's durations, 10 30 50 ms, interpolated at q × 2: p50 30; p95 30 + 0.9 × 20 = 48; p99 49.6.
    const [a] = shop?.shapes ?? [];
    expect([a?.p50Us, a?.p95Us, a?.p99Us].map((value) => round(value ?? 0))).toEqual([
      30_000, 48_000, 49_600,
    ]);
    // A whole day: 3 calls over 86,400 seconds.
    expect(data.seconds).toBe(86_400);
    expect(round(a?.perSecond ?? 0)).toBe(round(3 / 86_400));

    expect(shapesOf(findDatabase(data, "mongodb", "catalog"))).toEqual(["find products"]);
    expect(findDatabase(data, "mongodb", "catalog")?.shapes[0]).toMatchObject({
      kind: "operation",
      calls: 2,
    });
    expect(findDatabase(data, "redis", "0")?.shapes).toMatchObject([
      { shape: "GET", kind: "operation", calls: 1 },
    ]);
  });

  test("sorts a database's shapes by total time, p95, calls, or failures", async () => {
    const b = "SELECT * FROM orders WHERE id IN (?)";
    expect(await shapesSortedBy("time")).toEqual([ORDER_BY_ID, "SELECT orders", b]);
    // p95: C 60 ms, A 48 ms, B 20 ms.
    expect(await shapesSortedBy("p95")).toEqual(["SELECT orders", ORDER_BY_ID, b]);
    expect((await shapesSortedBy("calls"))[0]).toBe(ORDER_BY_ID);
    expect((await shapesSortedBy("failures"))[0]).toBe(b);
  });

  test("another environment reads its own calls", async () => {
    const data = await list(SHOP.id, `${DAY}&environment=staging`);
    expect(data.databases).toMatchObject([
      { system: "postgresql", database: "shop", calls: 1, shapes: [{ shape: "SELECT ?" }] },
    ]);
  });

  test("a project with spans but no database calls, and one with no span at all", async () => {
    const quiet = await insertProject(dashboard.db, { name: "Quiet" });
    expect(await list(quiet.id)).toMatchObject({ databases: [], received: false });
    const web = await insertProject(dashboard.db, { name: "Web only" });
    await send(await secretKeyOf(dashboard.db, web.id), {
      web: [span("GET /", "10:00:00", 5, { "http.route": "/" }, { kind: 2 })],
    });
    expect(await list(web.id)).toMatchObject({ databases: [], received: true });
  });
});

describe("normalization", () => {
  /** Each text alone in a database of its own, so each shape can be read back by its database. */
  const CASES: [text: string, shape: string][] = [
    // String and number literals.
    ["SELECT * FROM t WHERE a = 'x' AND b = 42", "SELECT * FROM t WHERE a = ? AND b = ?"],
    ["SELECT 1.5, -3, 2e10, 0x1F, .5", "SELECT ?, -?, ?, ?, .?"],
    ["UPDATE t SET name = 'O''Brien' WHERE id = 1", "UPDATE t SET name = ? WHERE id = ?"],
    [String.raw`SELECT 'it\'s' FROM t`, "SELECT ? FROM t"],
    ["SELECT 'unclosed", "SELECT ?"],
    // Digits in names stay; a numbered placeholder's number does not.
    ["SELECT col_1, table2.x FROM t3 WHERE a = $1", "SELECT col_1, table2.x FROM t3 WHERE a = $?"],
    // IN lists, however long, in either case, and VALUES rows.
    ["SELECT * FROM t WHERE id IN (1, 2, 3, 4)", "SELECT * FROM t WHERE id IN (?)"],
    ["SELECT * FROM t WHERE id IN(\n  1,\n  2\n)", "SELECT * FROM t WHERE id IN (?)"],
    [
      "select * from t where id in ('a','b') and x in ($1, $2)",
      "select * from t where id in (?) and x in (?)",
    ],
    [
      "INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y'), (3, 'z')",
      "INSERT INTO t (a, b) VALUES (?, ?)",
    ],
    ["insert into t values (1), (2)", "insert into t values (?)"],
    // Rows with function calls collapse; lists that are not rows of values do not.
    [
      "INSERT INTO t (a, b, c) VALUES ($1, $2, now()), ($3, $4, now())",
      "INSERT INTO t (a, b, c) VALUES ($?, $?, now())",
    ],
    ["SELECT sum(a), (b + c) FROM t", "SELECT sum(a), (b + c) FROM t"],
    ["SELECT sum(a), (b - c) FROM t", "SELECT sum(a), (b - c) FROM t"],
    // Named placeholders in IN lists.
    ["SELECT * FROM t WHERE id IN (@p0, @p1, @p2)", "SELECT * FROM t WHERE id IN (?)"],
    ["SELECT * FROM t WHERE id IN (:first, :second)", "SELECT * FROM t WHERE id IN (?)"],
    // Comments, with a quote in them; strings, with a comment marker in them.
    ["SELECT a -- don't\nFROM t", "SELECT a FROM t"],
    ["/*traceparent='00-abc-01'*/ SELECT a FROM t WHERE s = 'x'", "SELECT a FROM t WHERE s = ?"],
    ["SELECT a FROM t WHERE s = 'a--b' AND n = 1", "SELECT a FROM t WHERE s = ? AND n = ?"],
    ["UPDATE notes SET body = '--' WHERE id = 1", "UPDATE notes SET body = ? WHERE id = ?"],
    ["SELECT '/* x' FROM t /* y */ WHERE a = 1", "SELECT ? FROM t WHERE a = ?"],
    ["SELECT a FROM t /* unclosed", "SELECT a FROM t"],
    // White space.
    ["  SELECT\ta\n\n  FROM   t  ", "SELECT a FROM t"],
    // Unicode, literal and in names.
    ["SELECT 'é漢字🙂' FROM ünïcode WHERE x = 1", "SELECT ? FROM ünïcode WHERE x = ?"],
  ];

  test("replaces literals and IN lists, drops comments, collapses white space", async () => {
    const project = await insertProject(dashboard.db, { name: "Normalize" });
    await insertCalls(
      project.id,
      CASES.map(([text], index) => ({
        time: "11:00:00",
        durationMs: 1,
        attributes: {
          "db.system.name": "postgresql",
          "db.namespace": `case${index}`,
          "db.query.text": text,
        },
      })),
    );
    const data = await list(project.id);
    const shapes = Object.fromEntries(
      data.databases.map((item) => [item.database, item.shapes.map((shape) => shape.shape)]),
    );
    expect(CASES.map(([text], index) => [text, shapes[`case${index}`]])).toEqual(
      CASES.map(([text, shape]) => [text, [shape]]),
    );
  });

  test("cuts a shape to 1,000 characters; a summary wins over the text", async () => {
    const project = await insertProject(dashboard.db, { name: "Long" });
    const columns = Array.from({ length: 400 }, (_, index) => `column_${index}`).join(", ");
    await insertCalls(project.id, [
      {
        time: "11:00:00",
        durationMs: 1,
        attributes: {
          "db.system.name": "postgresql",
          "db.namespace": "long",
          "db.query.text": `SELECT ${columns} FROM t`,
        },
      },
      {
        time: "11:00:00",
        durationMs: 1,
        attributes: {
          "db.system.name": "postgresql",
          "db.namespace": "summary",
          "db.query.summary": "SELECT t",
          "db.query.text": "SELECT a FROM t WHERE b = 1",
          "db.operation.name": "SELECT",
        },
      },
    ]);
    const data = await list(project.id);
    const [long] = shapesOf(findDatabase(data, "postgresql", "long"));
    expect(long?.length).toBe(1000);
    expect(long).toBe(`SELECT ${columns} FROM t`.slice(0, 1000));
    expect(findDatabase(data, "postgresql", "summary")?.shapes).toMatchObject([
      { shape: "SELECT t", kind: "summary" },
    ]);
  });

  test("two long queries that differ only past the cut are two shapes", async () => {
    const project = await insertProject(dashboard.db, { name: "Past the cut" });
    const columns = Array.from({ length: 120 }, (_, index) => `u1_0.column_${index}`).join(",");
    const text = (where: string) => `select ${columns} from users u1_0 where ${where}=$1`;
    expect(text("u1_0.email").indexOf("where")).toBeGreaterThan(1000);
    await insertCalls(
      project.id,
      ["u1_0.email", "u1_0.id"].map((where) => ({
        time: "11:00:00",
        durationMs: 1,
        attributes: {
          "db.system.name": "postgresql",
          "db.namespace": "orm",
          "db.query.text": text(where),
        },
      })),
    );
    const shapes = findDatabase(await list(project.id), "postgresql", "orm")?.shapes ?? [];
    // The same 1,000 characters shown, two IDs.
    expect(shapes).toHaveLength(2);
    expect(new Set(shapes.map((shape) => shape.shape)).size).toBe(1);
    expect(new Set(shapes.map((shape) => shape.id)).size).toBe(2);
  });

  test("hostile query texts stay fast: long, regex-heavy, and Unicode", async () => {
    const project = await insertProject(dashboard.db, { name: "Hostile" });
    const texts = [
      "(".repeat(4096),
      "'".repeat(4095),
      String.raw`'\'`.repeat(1365),
      "/*".repeat(2048),
      "--".repeat(2048),
      ` IN (1,`.repeat(585),
      "VALUES (1),".repeat(372),
      "1.".repeat(2048),
      "🙂".repeat(1024),
      "\u0000   ".repeat(1000),
      // Past what ingestion keeps: only the first 4,096 characters are normalized.
      `SELECT ${"x".repeat(65_536)} 'a'`,
    ];
    const calls = Array.from({ length: 5000 }, (_, index) => ({
      time: "12:00:00",
      durationMs: 1,
      attributes: {
        "db.system.name": "postgresql",
        "db.namespace": "hostile",
        "db.query.text": texts[index % texts.length] ?? "",
      },
    }));
    await insertCalls(project.id, calls);
    const started = performance.now();
    const data = await list(project.id);
    const elapsed = performance.now() - started;
    const database = findDatabase(data, "postgresql", "hostile");
    expect(database?.calls).toBe(5000);
    // Every shape is at most 1,000 characters, and the whole list well under the 15-second limit.
    for (const shape of database?.shapes ?? []) {
      expect(Array.from(shape.shape).length).toBeLessThanOrEqual(1000);
    }
    expect(shapesOf(database)).toContain("(".repeat(1000));
    expect(shapesOf(database)).toContain("?");
    expect(elapsed).toBeLessThan(5000);
    // And its shape page.
    const id = database?.shapes[0]?.id ?? "";
    const started2 = performance.now();
    expect((await detail(project.id, id)).totals.calls).toBeGreaterThan(0);
    expect(performance.now() - started2).toBeLessThan(5000);
  });
});

describe("the bounds", () => {
  test("201 shapes keep 200, and 51 databases keep the 50 with the most time, saying so", async () => {
    const project = await insertProject(dashboard.db, { name: "Many" });
    await insertCalls(project.id, [
      // One database of 201 shapes, each 1 ms but the first, which is the slowest.
      ...Array.from({ length: 201 }, (_, index) => ({
        time: "11:00:00",
        durationMs: index === 0 ? 1000 : 1,
        attributes: {
          "db.system.name": "postgresql",
          "db.namespace": "big",
          "db.query.summary": `q${index}`,
        },
      })),
      // 50 more, each with one shape: database dN takes N + 2 ms, so d0 has the least.
      ...Array.from({ length: 50 }, (_, index) => ({
        time: "11:00:00",
        durationMs: index + 2,
        attributes: {
          "db.system.name": "mysql",
          "db.namespace": `d${index}`,
          "db.query.summary": "q",
        },
      })),
    ]);
    const data = await list(project.id);
    expect(data.truncated).toBe(true);
    expect(data.databases).toHaveLength(50);
    // big (1,200 ms) first, then d49 (51 ms) down to d1; d0 (2 ms) is cut.
    expect(data.databases[0]).toMatchObject({ database: "big", shapeCount: 201, calls: 201 });
    expect(data.databases[0]?.shapes).toHaveLength(200);
    expect(data.databases[0]?.shapes[0]?.shape).toBe("q0");
    expect(data.databases.map((item) => item.database)).not.toContain("d0");
    expect(data.databases.at(-1)?.database).toBe("d1");
    expect(data.databases.at(-1)).toMatchObject({ shapeCount: 1 });
  });
});

describe("GET /api/projects/:id/databases/shapes/:shapeId", () => {
  test("a shape's totals and charts agree with the list, and its slowest calls name their spans", async () => {
    const data = await list(SHOP.id);
    const a = findDatabase(data, "postgresql", "shop")?.shapes[0];
    expect(a?.shape).toBe(ORDER_BY_ID);
    const shape = await detail(SHOP.id, a?.id ?? "");
    expect(shape.shape).toEqual({
      kind: "query",
      text: ORDER_BY_ID,
      system: "postgresql",
      database: "shop",
    });
    const { calls, failed, totalUs, p50Us, p95Us, p99Us, perSecond, services, serviceCount } =
      a ?? ({} as Shape);
    expect(shape.totals).toEqual({
      calls,
      failed,
      totalUs,
      p50Us,
      p95Us,
      p99Us,
      perSecond,
      services,
      serviceCount,
    });
    expect(shape).toMatchObject({ stepSeconds: 300, buckets: 288 });
    // 10:00 to 10:05 is bucket 120 (a1 10 ms, a2 30 ms); 10:05 to 10:10 bucket 121 (a3 50 ms).
    expect(sum(shape.counts.calls)).toBe(3);
    expect(shape.counts.calls[120]).toBe(2);
    expect(shape.counts.calls[121]).toBe(1);
    expect(round(shape.perSecond[120] ?? 0)).toBe(round(2 / 300));
    expect(shape.perSecond[0]).toBe(0);
    expect(shape.failedShare[120]).toBe(0);
    expect(shape.failedShare[0]).toBeNull();
    // Bucket 120, 10 and 30 ms: p50 20, p95 29, p99 29.8.
    expect([120, 121].map((index) => round(shape.durations.p95Us[index] ?? 0))).toEqual([
      29_000, 50_000,
    ]);
    expect(round(shape.durations.p50Us[120] ?? 0)).toBe(20_000);
    expect(shape.durations.p99Us[0]).toBeNull();
    // Slowest first, each with its trace, span, and start.
    expect(shape.slowest).toEqual([
      {
        traceId: SHOP.traces.t3,
        spanId: SHOP.spans.legacy,
        start: `${YESTERDAY}T10:06:00.000Z`,
        startNs: String(at("10:06:00")),
        durationUs: 50_000,
        service: "legacy",
        failed: false,
      },
      expect.objectContaining({
        traceId: SHOP.traces.t2,
        spanId: SHOP.spans.a2,
        durationUs: 30_000,
      }),
      expect.objectContaining({
        traceId: SHOP.traces.t1,
        spanId: SHOP.spans.a1,
        durationUs: 10_000,
      }),
    ]);
    // Its services, most calls first: api 2 (10, 30 ms), legacy 1 (50 ms).
    expect(shape.services.map(({ service, calls: n, totalUs: t }) => [service, n, t])).toEqual([
      ["api", 2, 40_000],
      ["legacy", 1, 50_000],
    ]);
    // The routes of its calls: api's two in requests of GET /orders/{id}; legacy's in none.
    expect(shape.sampled).toBe(3);
    expect(shape.callers).toEqual([
      { service: "api", route: "/orders/{id}", calls: 2 },
      { service: "legacy", route: null, calls: 1 },
    ]);
  });

  test("a failed call's share, and a shape with no call in the period", async () => {
    const data = await list(SHOP.id, `${DAY}&sort=failures`);
    const b = findDatabase(data, "postgresql", "shop")?.shapes[0];
    const shape = await detail(SHOP.id, b?.id ?? "");
    expect(shape.totals).toMatchObject({ calls: 1, failed: 1 });
    expect(shape.failedShare[120]).toBe(1);
    expect(shape.slowest[0]).toMatchObject({ failed: true, service: "api" });
    expect(shape.callers).toEqual([{ service: "api", route: null, calls: 1 }]);

    const nothing = await detail(SHOP.id, "12345");
    expect(nothing).toMatchObject({ shape: null, totals: { calls: 0 }, slowest: [], callers: [] });
    expect(sum(nothing.counts.calls)).toBe(0);
  });
});

describe("migration 0003", () => {
  test("works out the columns for spans stored before it", async () => {
    const config = loadConfig().clickhouse;
    const database = testName();
    const admin = createClickHouse(config, { database: "default" });
    const client = createClickHouse(config, { database });
    try {
      const before = CLICKHOUSE_MIGRATIONS.filter((item) => !item.name.startsWith("0003"));
      await migrateClickHouse(admin, database, before);
      const stored = (id: string, kind: string, attributes: Record<string, string>) => ({
        project_id: randomUUID(),
        timestamp: `${YESTERDAY} 10:00:00`,
        id,
        name: "query",
        kind,
        service: "api",
        environment: "production",
        attributes,
        events: "[]",
        links: "[]",
      });
      await client.insert({
        table: "spans",
        format: "JSONEachRow",
        values: [
          stored("a", "client", {
            "db.system": "postgresql",
            "db.name": "shop",
            "db.statement": "SELECT * FROM t WHERE id = 7",
          }),
          stored("b", "server", { "http.route": "/" }),
        ],
      });
      await migrateClickHouse(admin, database);
      const result = await client.query({
        query: `SELECT id, db_system, db_namespace, db_shape_kind, db_shape, db_shape_id != 0 AS named
                FROM spans ORDER BY id`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([
        {
          id: "a",
          db_system: "postgresql",
          db_namespace: "shop",
          db_shape_kind: 2,
          db_shape: "SELECT * FROM t WHERE id = ?",
          named: 1,
        },
        { id: "b", db_system: "", db_namespace: "", db_shape_kind: 0, db_shape: "", named: 0 },
      ]);
    } finally {
      await client.close();
      await admin.command({ query: `DROP DATABASE IF EXISTS ${identifier(database)}` });
      await admin.close();
    }
  });
});

describe("parameters and access", () => {
  test("refuses bad parameters", async () => {
    const bad = [
      `/databases?${DAY}&sort=slowest`,
      `/databases?period=forever`,
      `/databases?${DAY}&environment=no%20spaces`,
      `/databases/shapes/abc?${DAY}`,
      `/databases/shapes/-1?${DAY}`,
      `/databases/shapes/18446744073709551616?${DAY}`,
      `/databases/shapes/123456789012345678901?${DAY}`,
      `/databases/shapes/1?period=forever`,
    ];
    const answers: Record<string, number> = {};
    for (const path of bad) answers[path] = (await get(SHOP.id, path)).statusCode;
    expect(answers).toEqual(Object.fromEntries(bad.map((path) => [path, 400])));
    expect((await get(SHOP.id, "/databases/shapes/18446744073709551615?" + DAY)).statusCode).toBe(
      200,
    );
  });

  test("signed out gets 401; an unknown project 404; another project reads nothing of this one's", async () => {
    const data = await list(SHOP.id);
    const id = data.databases[0]?.shapes[0]?.id ?? "";
    for (const path of [`/databases?${DAY}`, `/databases/shapes/${id}?${DAY}`]) {
      expect((await get(SHOP.id, path, { signedIn: false })).statusCode).toBe(401);
      const missing = await get(randomUUID(), path);
      expect({ status: missing.statusCode, body: missing.json() }).toEqual({
        status: 404,
        body: { error: "not_found", message: "No project has this ID." },
      });
    }
    const other = await insertProject(dashboard.db, { name: "Another shop" });
    expect((await list(other.id)).databases).toEqual([]);
    const theirs = await detail(other.id, id);
    expect(theirs).toMatchObject({ shape: null, totals: { calls: 0 }, slowest: [] });
  });
});
