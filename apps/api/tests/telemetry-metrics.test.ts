import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  bucketsOf,
  MAX_SERIES,
  metricWindow,
  quantileOfBuckets,
  SPARKLINE_BUCKETS,
  SPLIT_LINES,
} from "../src/telemetry/metrics.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

const MS = 1_000_000n;
/** Yesterday, in UTC (the instance's timezone): the one day every chart here reads, in 5-minute buckets. */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const DAY = `from=${YESTERDAY}&to=${YESTERDAY}`;
/** Yesterday at a time of day, "10:02:30", in nanoseconds since 1970. */
const at = (time: string) => BigInt(Date.parse(`${YESTERDAY}T${time}Z`)) * MS;
/** The 5-minute bucket of a time of day: 10:00 is bucket 120. */
const bucketOf = (time: string) => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return Math.floor((hours * 60 + minutes) / 5);
};

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A value as the tests compare them: 4 decimals. */
const rounded = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * A process counting 10 a second since `start` ("09:00"), reporting every
 * minute from 10:00, `offsetSeconds` after the minute.
 */
const writer = (start: string, offsetSeconds: number) =>
  Array.from({ length: 11 }, (_, i) => {
    const moment = Date.parse(`${YESTERDAY}T10:00:00Z`) + (i * 60 + offsetSeconds) * 1000;
    return {
      time: new Date(moment).toISOString().slice(11, 19),
      start: `${start}:00`,
      value: ((moment - Date.parse(`${YESTERDAY}T${start}:00Z`)) / 1000) * 10,
    };
  });

/** A time of day some minutes after another: timeAfter("08:00", 75) is "09:15:00". */
const timeAfter = (from: string, minutes: number) => {
  const [hours = 0, mins = 0] = from.split(":").map(Number);
  const total = hours * 60 + mins + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}:00`;
};

interface Point {
  time: string;
  /** The start of a cumulative or delta point; left out: unknown (0). */
  start?: string;
  attributes?: Record<string, string>;
}

type Data =
  | { gauge: { dataPoints: object[] } }
  | { sum: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: object[] } }
  | { histogram: { aggregationTemporality: number; dataPoints: object[] } };

const CUMULATIVE = 2;
const DELTA = 1;

const pointTimes = (point: Point) => ({
  timeUnixNano: String(at(point.time)),
  startTimeUnixNano: point.start === undefined ? "0" : String(at(point.start)),
  attributes: keyValues(point.attributes ?? {}),
});

const values = (points: (Point & { value: number })[]) =>
  points.map((point) => ({ ...pointTimes(point), asDouble: point.value }));

const gauge = (points: (Point & { value: number })[]): Data => ({
  gauge: { dataPoints: values(points) },
});

const sum = (
  temporality: number,
  isMonotonic: boolean,
  points: (Point & { value: number })[],
): Data => ({
  sum: { aggregationTemporality: temporality, isMonotonic, dataPoints: values(points) },
});

interface HistogramPoint extends Point {
  counts: number[];
  /** The count, when it is not the buckets' total (a point without buckets). */
  count?: number;
  min?: number;
  max?: number;
}

const histogram = (temporality: number, bounds: number[], points: HistogramPoint[]): Data => ({
  histogram: {
    aggregationTemporality: temporality,
    dataPoints: points.map((point) => ({
      ...pointTimes(point),
      count: String(point.count ?? point.counts.reduce((total, count) => total + count, 0)),
      bucketCounts: point.counts.map(String),
      explicitBounds: bounds,
      ...(point.min === undefined ? {} : { min: point.min }),
      ...(point.max === undefined ? {} : { max: point.max }),
    })),
  },
});

async function send(path: string, secretKey: string, body: object) {
  const response = await dashboard.app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
    payload: JSON.stringify(body),
  });
  expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 200, body: {} });
}

/** Sends metrics, each group under its own service (and environment). */
async function sendMetrics(
  secretKey: string,
  groups: {
    service: string;
    environment?: string;
    metrics: ({ name: string; unit?: string } & Data)[];
  }[],
) {
  await send("/v1/metrics", secretKey, {
    resourceMetrics: groups.map((group) => ({
      resource: {
        attributes: keyValues({
          "service.name": group.service,
          ...(group.environment === undefined
            ? {}
            : { "deployment.environment.name": group.environment }),
        }),
      },
      scopeMetrics: [{ scope: { name: "app" }, metrics: group.metrics }],
    })),
  });
}

async function newProject(name: string) {
  const project = await insertProject(dashboard.db, { name });
  return { id: project.id, secretKey: await secretKeyOf(dashboard.db, project.id) };
}

function get(projectId: string, path: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({ url: `/api/projects/${projectId}${path}`, headers: { cookie } });
}

async function getJson(projectId: string, path: string) {
  const response = await get(projectId, path);
  expect({ path, status: response.statusCode, body: response.json() }).toMatchObject({
    path,
    status: 200,
  });
  return response.json();
}

async function statuses(projectId: string, paths: string[], cookie = dashboard.cookie) {
  const answers: Record<string, number> = {};
  for (const path of paths) answers[path] = (await get(projectId, path, cookie)).statusCode;
  return answers;
}

const all = (paths: string[], status: number) =>
  Object.fromEntries(paths.map((path) => [path, status]));

interface Series {
  value: string | null;
  other: boolean;
  volume: number;
  values: Record<string, (number | null)[]>;
}

/** A chart of the shop's metric, for yesterday. */
const chart = (projectId: string, name: string, kind: string, extra = "") =>
  getJson(projectId, `/metrics/chart?${DAY}&name=${encodeURIComponent(name)}&kind=${kind}${extra}`);

/** A line's values at the buckets of these times, rounded as the test checks them by hand. */
const valuesAt = (series: Series, measure: string, times: string[]) =>
  times.map((time) => {
    const value = series.values[measure]?.[bucketOf(time)];
    return value === null || value === undefined ? value : Math.round(value * 10_000) / 10_000;
  });

/** Worker i sends i + 1 points of value i, a second apart. */
const workerPoints = (workers: number) =>
  Array.from({ length: workers }, (_worker, worker) =>
    Array.from({ length: worker + 1 }, (_point, n) => ({
      time: `10:00:${String(n).padStart(2, "0")}`,
      value: worker,
      attributes: { worker: `w${worker}` },
    })),
  ).flat();

let shop = { id: "", secretKey: "" };

beforeAll(async () => {
  dashboard = await signedInDashboard();
  shop = await newProject("Shop");
  const metrics = [
    // Two hosts' memory: 10, 20, 30 and 40 in 10:00–10:05; 5 in 10:05–10:10.
    {
      name: "process.memory",
      unit: "MiBy",
      ...gauge([
        { time: "10:00:30", value: 10, attributes: { host: "a" } },
        { time: "10:02:00", value: 20, attributes: { host: "a" } },
        { time: "10:04:00", value: 30, attributes: { host: "a" } },
        { time: "10:06:00", value: 5, attributes: { host: "a" } },
        { time: "10:01:00", value: 40, attributes: { host: "b" } },
      ]),
    },
    // Requests, cumulative, two routes.
    {
      name: "http.requests",
      unit: "{request}",
      ...sum(CUMULATIVE, true, [
        // /a: started at 09:59, so its first value counts: 100 over 60 s.
        { time: "10:00:00", start: "09:59:00", value: 100, attributes: { route: "/a" } },
        { time: "10:01:00", start: "09:59:00", value: 160, attributes: { route: "/a" } },
        { time: "10:02:00", start: "09:59:00", value: 220, attributes: { route: "/a" } },
        // Down, with the same start: a reset; 30 counts, over the 60 s since the point before.
        { time: "10:03:00", start: "09:59:00", value: 30, attributes: { route: "/a" } },
        { time: "10:04:00", start: "09:59:00", value: 90, attributes: { route: "/a" } },
        // Started again at 10:04:30, after the point before: 150 counts, over 30 s.
        { time: "10:05:00", start: "10:04:30", value: 150, attributes: { route: "/a" } },
        { time: "10:06:00", start: "10:04:30", value: 180, attributes: { route: "/a" } },
        // /b: no start, so its first value is only a base: 120 more over 120 s.
        { time: "10:00:00", value: 1000, attributes: { route: "/b" } },
        { time: "10:02:00", value: 1120, attributes: { route: "/b" } },
      ]),
    },
    // Jobs, delta: 30 and 60 in 10:00–10:05, 15 in 10:05–10:10.
    {
      name: "jobs.done",
      ...sum(DELTA, true, [
        { time: "10:01:00", start: "10:00:00", value: 30 },
        { time: "10:03:00", start: "10:01:00", value: 60 },
        { time: "10:07:00", start: "10:03:00", value: 15 },
      ]),
    },
    // Connections open, an up-down counter of two pools: each one's last value, added up.
    {
      name: "db.connections",
      ...sum(CUMULATIVE, false, [
        { time: "10:00:00", start: "09:00:00", value: 3, attributes: { pool: "a" } },
        { time: "10:02:00", start: "09:00:00", value: 5, attributes: { pool: "a" } },
        { time: "10:01:00", start: "09:00:00", value: 7, attributes: { pool: "b" } },
      ]),
    },
    // Request durations, cumulative, started at 09:00.
    {
      name: "http.duration",
      unit: "ms",
      ...histogram(
        CUMULATIVE,
        [10, 50, 100],
        [
          { time: "09:58:00", start: "09:00:00", counts: [5, 10, 4, 1], max: 150 },
          { time: "10:02:00", start: "09:00:00", counts: [5, 30, 14, 1], max: 150 },
        ],
      ),
    },
    // Queue waits, delta.
    {
      name: "queue.wait",
      unit: "ms",
      ...histogram(
        DELTA,
        [10, 50, 100],
        [{ time: "10:01:00", start: "10:00:00", counts: [2, 0, 0, 2], min: 1, max: 300 }],
      ),
    },
  ];
  // Sent twice, as an exporter retries after a lost answer: each point counts once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await sendMetrics(shop.secretKey, [{ service: "web", metrics }]);
  }
  // Another service's memory, in staging: not in production's charts.
  await sendMetrics(shop.secretKey, [
    {
      service: "worker",
      environment: "staging",
      metrics: [{ name: "process.memory", ...gauge([{ time: "10:00:00", value: 999 }]) }],
    },
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("GET /api/projects/:id/metrics", () => {
  test("lists the metrics by name, with kind, unit, services, and when last seen", async () => {
    const list = await getJson(shop.id, `/metrics?${DAY}`);
    expect(list).toMatchObject({
      timeZone: "UTC",
      environment: "production",
      firstDay: YESTERDAY,
      truncated: false,
      received: true,
    });
    expect(list.environments).toEqual(["production", "staging"]);
    expect(list.metrics).toEqual([
      {
        name: "db.connections",
        kind: "updown",
        unit: "",
        services: ["web"],
        serviceCount: 1,
        lastSeen: new Date(Number(at("10:02:00") / MS)).toISOString(),
      },
      expect.objectContaining({ name: "http.duration", kind: "histogram", unit: "ms" }),
      expect.objectContaining({ name: "http.requests", kind: "counter", unit: "{request}" }),
      expect.objectContaining({ name: "jobs.done", kind: "counter" }),
      expect.objectContaining({
        name: "process.memory",
        kind: "gauge",
        unit: "MiBy",
        lastSeen: new Date(Number(at("10:06:00") / MS)).toISOString(),
      }),
      expect.objectContaining({ name: "queue.wait", kind: "histogram" }),
    ]);
    const staging = await getJson(shop.id, `/metrics?${DAY}&environment=staging`);
    expect(staging.metrics).toEqual([
      expect.objectContaining({ name: "process.memory", services: ["worker"] }),
    ]);
  });

  test("says when the project has never sent a metric", async () => {
    const quiet = await newProject("Quiet");
    expect(await getJson(quiet.id, `/metrics?${DAY}`)).toMatchObject({
      metrics: [],
      received: false,
    });
    expect(await getJson(shop.id, `/metrics?${DAY}&environment=test`)).toMatchObject({
      metrics: [],
      received: true,
    });
  });
});

describe("GET /api/projects/:id/metrics/chart", () => {
  test("buckets a day in 5 minutes, from the start of the day", async () => {
    const memory = await chart(shop.id, "process.memory", "gauge");
    expect(memory).toMatchObject({
      name: "process.memory",
      kind: "gauge",
      unit: "MiBy",
      start: `${YESTERDAY}T00:00:00.000Z`,
      stepSeconds: 300,
      buckets: 288,
      split: null,
      keys: ["host"],
      seriesCount: 2,
      seriesCapped: false,
    });
    expect(memory.series).toHaveLength(1);
    expect(memory.series[0].values.avg).toHaveLength(288);
  });

  test("a gauge: the average, minimum, and maximum per bucket", async () => {
    const [line] = (await chart(shop.id, "process.memory", "gauge")).series;
    const times = ["09:55", "10:00", "10:05"];
    // 10:00–10:05: 10, 20, 30, 40. 10:05–10:10: 5. Nothing before.
    expect(valuesAt(line, "avg", times)).toEqual([null, 25, 5]);
    expect(valuesAt(line, "min", times)).toEqual([null, 10, 5]);
    expect(valuesAt(line, "max", times)).toEqual([null, 40, 5]);
    expect(line).toMatchObject({ value: null, other: false, volume: 5 });
  });

  test("a cumulative counter: the change between points per second, with resets", async () => {
    const requests = await chart(shop.id, "http.requests", "counter");
    const [line] = requests.series;
    // Each increase counts in the buckets its interval covers. 09:55–10:00:
    // /a's first 100, since its start at 09:59. 10:00–10:05: /a 60 + 60 + 30
    // (reset) + 60, and 150 since it started again at 10:04:30; /b 120. So
    // 480 over 300 s. 10:05–10:10: /a 30.
    expect(valuesAt(line, "rate", ["09:50", "09:55", "10:00", "10:05", "10:10"])).toEqual([
      null,
      0.3333,
      1.6,
      0.1,
      null,
    ]);
    expect(line.volume).toBe(490 + 120);
  });

  test("a delta counter: the values per bucket over the bucket's seconds", async () => {
    const [line] = (await chart(shop.id, "jobs.done", "counter")).series;
    // (30 + 60) / 300 s, then 15 / 300 s.
    expect(valuesAt(line, "rate", ["10:00", "10:05"])).toEqual([0.3, 0.05]);
  });

  test("an up-down counter: each series' last value in the bucket, added up", async () => {
    const [line] = (await chart(shop.id, "db.connections", "updown")).series;
    // Pool a's last is 5 (at 10:02), pool b's 7.
    expect(valuesAt(line, "sum", ["09:55", "10:00"])).toEqual([null, 12]);
    const split = await chart(shop.id, "db.connections", "updown", "&split=pool");
    expect(
      split.series.map((series: Series) => [series.value, series.values.sum?.[bucketOf("10:00")]]),
    ).toEqual([
      ["a", 5],
      ["b", 7],
    ]);
  });

  test("a delta up-down counter: its changes in the bucket, added up, in charts, sparklines, and rules", async () => {
    const project = await newProject("Delta up-down");
    await sendMetrics(project.secretKey, [
      {
        service: "web",
        metrics: [
          // Changes: +5 and -2 in 10:00–10:05, +4 in 10:05–10:10.
          {
            name: "queue.depth",
            ...sum(DELTA, false, [
              { time: "10:01:00", start: "10:00:00", value: 5 },
              { time: "10:03:00", start: "10:01:00", value: -2 },
              { time: "10:07:00", start: "10:03:00", value: 4 },
            ]),
          },
          // The same as levels: still the last value.
          {
            name: "queue.level",
            ...sum(CUMULATIVE, false, [
              { time: "10:01:00", start: "09:00:00", value: 5 },
              { time: "10:03:00", start: "09:00:00", value: 3 },
              { time: "10:07:00", start: "09:00:00", value: 7 },
            ]),
          },
        ],
      },
    ]);
    const [delta] = (await chart(project.id, "queue.depth", "updown")).series;
    expect(valuesAt(delta, "sum", ["09:55", "10:00", "10:05"])).toEqual([null, 3, 4]);
    const [cumulative] = (await chart(project.id, "queue.level", "updown")).series;
    expect(valuesAt(cumulative, "sum", ["10:00", "10:05"])).toEqual([3, 7]);

    // A sparkline's hour from 10:00, as its chart reads it.
    const hour = 10;
    const sparkline = async (name: string) =>
      (
        await getJson(
          project.id,
          `/metrics/sparkline?${DAY}&name=${encodeURIComponent(name)}&kind=updown`,
        )
      ).values[hour];
    expect(await sparkline("queue.depth")).toBe(7);
    expect(await sparkline("queue.level")).toBe(7);

    // A metric rule's window from 10:00: the delta series' changes in it. A
    // level counts only while fresh (its last point at most 2 minutes before
    // the end); a change counts wherever it falls.
    const window = async (name: string, end: string) =>
      (
        await metricWindow(
          dashboard.reader,
          { projectId: project.id, environment: "production" },
          { name, kind: "updown" },
          new Date(Number(at("10:00:00") / MS)),
          new Date(Number(at(end) / MS)),
          new Date(Number(at(end) / MS)),
        )
      ).values;
    expect(await window("queue.depth", "10:08:00")).toEqual({ sum: 7 });
    expect(await window("queue.level", "10:08:00")).toEqual({ sum: 7 });
    expect(await window("queue.depth", "10:10:00")).toEqual({ sum: 7 });
    expect(await window("queue.level", "10:10:00")).toEqual({ sum: null });
  });

  test("a sparse sender's increases spread over the buckets between its points", async () => {
    const sparse = await newProject("Sparse");
    // Three instances, a true 1 request a second each since 07:00, export
    // every 15 minutes, five minutes apart: 3 a second in every bucket.
    const points = [0, 1, 2].flatMap((instance) =>
      Array.from({ length: 12 }, (_, k) => {
        const time = timeAfter("08:00", instance * 5 + k * 15);
        return {
          time,
          start: "07:00:00",
          value:
            (Date.parse(`${YESTERDAY}T${time}Z`) - Date.parse(`${YESTERDAY}T07:00:00Z`)) / 1000,
          attributes: { instance: String(instance) },
        };
      }),
    );
    await sendMetrics(sparse.secretKey, [
      { service: "web", metrics: [{ name: "requests", ...sum(CUMULATIVE, true, points) }] },
    ]);
    const [line] = (await chart(sparse.id, "requests", "counter")).series;
    // 07:00 to 10:45, when the first instance's points end.
    const times = Array.from({ length: 45 }, (_, i) => timeAfter("07:00", i * 5));
    expect(valuesAt(line, "rate", times)).toEqual(times.map(() => 3));
  });

  test("two writers of one series, told apart by their start, do not mix", async () => {
    const shared = await newProject("Shared");
    // Two processes with the same attributes, each 10 a second since its
    // start (09:00 and 09:30), reporting every minute, 30 s apart.
    await sendMetrics(shared.secretKey, [
      {
        service: "gunicorn",
        metrics: [
          {
            name: "requests",
            ...sum(CUMULATIVE, true, [...writer("09:00", 0), ...writer("09:30", 30)]),
          },
        ],
      },
    ]);
    const [line] = (await chart(shared.id, "requests", "counter")).series;
    expect(valuesAt(line, "rate", ["09:55", "10:00", "10:05"])).toEqual([20, 20, 20]);
  });

  test("a cumulative histogram: percentiles of each bucket's observations, and their rate", async () => {
    const durations = await chart(shop.id, "http.duration", "histogram");
    expect(durations.bounds).toEqual([10, 50, 100]);
    const [line] = durations.series;
    // 09:55–10:00: the first point, counted from its start at 09:00: [5, 10,
    // 4, 1], 20 observations. p50 is the 10th: in (10, 50],
    // after 5, the 5th of 10: 10 + 40 × 5 / 10 = 30. p95, the 19th: the 4th
    // of 4 in (50, 100]: 100. p99, 19.8th: in the last bucket, (100, max
    // 150]: 100 + 50 × 0.8 = 140.
    // 10:00–10:05: the change, [0, 20, 10, 0], 30 observations since 09:58.
    // p50, the 15th: 10 + 40 × 15 / 20 = 40. p95, the 28.5th: 50 + 50 × 8.5
    // / 10 = 92.5. p99, the 29.7th: 50 + 50 × 9.7 / 10 = 98.5.
    const times = ["09:55", "10:00"];
    expect(valuesAt(line, "p50", times)).toEqual([30, 40]);
    expect(valuesAt(line, "p95", times)).toEqual([100, 92.5]);
    expect(valuesAt(line, "p99", times)).toEqual([140, 98.5]);
    // The counts stay in the point's bucket; the observations spread over
    // their interval: 20 over 09:00–09:58, 3 minutes of it in 09:55–10:00;
    // 30 over 09:58–10:02, half in each bucket.
    expect(valuesAt(line, "rate", times)).toEqual([
      rounded(((20 * 3) / 58 + 15) / 300),
      rounded(15 / 300),
    ]);
    expect(durations).toMatchObject({ percentiles: true, skippedSeries: 0 });
  });

  test("a delta histogram: each point's buckets as they are, min and max at the ends", async () => {
    const [line] = (await chart(shop.id, "queue.wait", "histogram")).series;
    // [2, 0, 0, 2], min 1, max 300. p50, the 2nd: in (min 1, 10]: 1 + 9 × 2 / 2
    // = 10. p95, the 3.8th: in (100, max 300]: 100 + 200 × 1.8 / 2 = 280; p99:
    // 100 + 200 × 1.96 / 2 = 296. 4 observations over 300 s.
    expect(valuesAt(line, "p50", ["10:00"])).toEqual([10]);
    expect(valuesAt(line, "p95", ["10:00"])).toEqual([280]);
    expect(valuesAt(line, "p99", ["10:00"])).toEqual([296]);
    expect(valuesAt(line, "rate", ["10:00"])).toEqual([Math.round((4 / 300) * 10_000) / 10_000]);
  });

  test("a histogram without bucket counts: its rate from the count, no percentiles", async () => {
    const plain = await newProject("Plain");
    await sendMetrics(plain.secretKey, [
      {
        service: "web",
        metrics: [
          {
            name: "jobs.duration",
            ...histogram(
              DELTA,
              [],
              [{ time: "10:01:00", start: "10:00:00", counts: [], count: 6 }],
            ),
          },
        ],
      },
    ]);
    const durations = await chart(plain.id, "jobs.duration", "histogram");
    expect(durations).toMatchObject({ percentiles: false, skippedSeries: 1, seriesCount: 1 });
    const [line] = durations.series;
    expect(valuesAt(line, "rate", ["10:00"])).toEqual([0.02]);
    expect(valuesAt(line, "p50", ["10:00"])).toEqual([null]);
  });

  test("splits by an attribute: a line per value", async () => {
    const requests = await chart(shop.id, "http.requests", "counter", "&split=route");
    expect(requests.split).toBe("route");
    expect(requests.keys).toEqual(["route"]);
    // Most volume first: /a's increases, 490, then /b's, 120.
    expect(requests.series.map((line: Series) => [line.value, line.other, line.volume])).toEqual([
      ["/a", false, 490],
      ["/b", false, 120],
    ]);
    const [a, b] = requests.series;
    expect(valuesAt(a, "rate", ["09:55", "10:00", "10:05"])).toEqual([0.3333, 1.2, 0.1]);
    expect(valuesAt(b, "rate", ["09:55", "10:00", "10:05"])).toEqual([null, 0.4, null]);
    // A key the points do not have: one line, of points without it.
    const none = await chart(shop.id, "http.requests", "counter", "&split=method");
    expect(none.series.map((line: Series) => line.value)).toEqual([null]);
  });

  test(`folds all but the top ${SPLIT_LINES - 1} values into "other" past ${SPLIT_LINES}`, async () => {
    const busy = await newProject("Workers");
    const points = workerPoints;
    await sendMetrics(busy.secretKey, [
      { service: "jobs", metrics: [{ name: "queue.depth", ...gauge(points(10)) }] },
      { service: "jobs", metrics: [{ name: "queue.size", ...gauge(points(SPLIT_LINES)) }] },
    ]);
    const depth = await chart(busy.id, "queue.depth", "gauge", "&split=worker");
    // w9 to w3 by volume; w0, w1, and w2 (1 + 2 + 3 points) fold into other.
    expect(depth.series.map((line: Series) => [line.value, line.other, line.volume])).toEqual([
      ["w9", false, 10],
      ["w8", false, 9],
      ["w7", false, 8],
      ["w6", false, 7],
      ["w5", false, 6],
      ["w4", false, 5],
      ["w3", false, 4],
      [null, true, 6],
    ]);
    const other = depth.series.at(-1);
    // (0 × 1 + 1 × 2 + 2 × 3) / 6
    expect(valuesAt(other, "avg", ["10:00"])).toEqual([1.3333]);
    expect(valuesAt(other, "min", ["10:00"])).toEqual([0]);
    expect(valuesAt(other, "max", ["10:00"])).toEqual([2]);
    // Exactly as many values as lines: no other.
    const size = await chart(busy.id, "queue.size", "gauge", "&split=worker");
    expect(size.series).toHaveLength(SPLIT_LINES);
    expect(size.series.some((line: Series) => line.other)).toBe(false);
  });

  test(`reads at most ${MAX_SERIES} series, and says so`, async () => {
    const many = await newProject("Many");
    const points = Array.from({ length: MAX_SERIES + 1 }, (_, i) => ({
      time: "10:00:00",
      value: 1,
      attributes: { id: String(i) },
    }));
    await sendMetrics(many.secretKey, [
      { service: "web", metrics: [{ name: "sessions", ...gauge(points) }] },
    ]);
    const sessions = await chart(many.id, "sessions", "gauge");
    expect(sessions).toMatchObject({ seriesCount: MAX_SERIES, seriesCapped: true });
    expect(sessions.series[0].volume).toBe(MAX_SERIES);
  });

  test("a metric with nothing in the period has no lines", async () => {
    const nothing = await chart(shop.id, "no.such.metric", "gauge");
    expect(nothing).toMatchObject({ series: [], seriesCount: 0, buckets: 288 });
    // The kind picks the rows: the gauge is not a counter.
    expect((await chart(shop.id, "process.memory", "counter")).series).toEqual([]);
  });

  test("refuses bad parameters", async () => {
    const bad = [
      `/metrics/chart?${DAY}&kind=gauge`,
      `/metrics/chart?${DAY}&name=x`,
      `/metrics/chart?${DAY}&name=x&kind=summary`,
      `/metrics/chart?${DAY}&name=${"x".repeat(1025)}`,
      `/metrics/chart?${DAY}&name=${"é".repeat(600)}&kind=gauge`,
      `/metrics/chart?${DAY}&name=x&kind=gauge&split=`,
      `/metrics/chart?${DAY}&name=x&kind=gauge&split=${"k".repeat(257)}`,
      `/metrics/chart?period=forever&name=x&kind=gauge`,
      `/metrics?period=forever`,
      `/metrics?${DAY}&environment=no%20spaces`,
      `/services?period=forever`,
    ];
    expect(await statuses(shop.id, bad)).toEqual(all(bad, 400));
  });
});

/** A range from `firstDay` to today (20 November 2026, UTC), as the periods ask for it. */
const endingToday = (firstDay: string) => ({
  firstDay,
  lastDay: "2026-11-20",
  dayStart: new Date(`${firstDay}T00:00:00Z`),
  from: new Date(`${firstDay}T00:00:00Z`),
  to: new Date("2026-11-21T00:00:00Z"),
});

describe("chart buckets", () => {
  test("percentiles from buckets, by hand", () => {
    // Nothing counted.
    expect(quantileOfBuckets([10], [0, 0], 0.5, null, null)).toBeNull();
    // In the last bucket without a maximum: its lower bound.
    expect(quantileOfBuckets([10, 20], [0, 0, 4], 0.5, null, null)).toBe(20);
    // The first bucket without a minimum starts at 0: 4 values in (0, 10], the 2nd is 5.
    expect(quantileOfBuckets([10, 20], [4, 0, 0], 0.5, null, null)).toBe(5);
    // A first bound below 0 is where it starts.
    expect(quantileOfBuckets([-5, 20], [4, 0, 0], 0.5, null, null)).toBe(-5);
  });

  test("a range of days keeps its step at every time of day; today's grows with the day", () => {
    // Just after midnight, a 15-minute mark, and an hour; 06:00, when 7 days
    // of 30 minutes passed 300 buckets; noon; and just before midnight.
    const times = ["00:05", "00:15:30", "00:20", "06:00", "06:00:30", "12:00", "13:00:30", "23:55"];
    for (const [period, firstDay, chartStep, sparklineStep] of [
      ["7d", "2026-11-14", 3600, 21_600],
      ["30d", "2026-10-22", 10_800, 86_400],
      ["90d", "2026-08-23", 43_200, 604_800],
      ["12m", "2025-11-21", 172_800, 604_800],
    ] as const) {
      for (const time of times) {
        const now = new Date(`2026-11-20T${time}Z`);
        expect({
          period,
          time,
          chartStep: bucketsOf(endingToday(firstDay), now).stepMs / 1000,
          sparklineStep: bucketsOf(endingToday(firstDay), now, SPARKLINE_BUCKETS).stepMs / 1000,
        }).toEqual({ period, time, chartStep, sparklineStep });
      }
    }
    // 7 days at 00:05: the 6 days before, hourly, and today's first hour.
    const early = bucketsOf(endingToday("2026-11-14"), new Date("2026-11-20T00:05:00Z"));
    expect(early.count).toBe(6 * 24 + 1);
    // Today's chart is drawn up to now, so its step follows the part that has passed.
    const today = endingToday("2026-11-20");
    expect(bucketsOf(today, new Date("2026-11-20T00:05:00Z")).stepMs).toBe(60_000);
    expect(bucketsOf(today, new Date("2026-11-20T23:55:00Z")).stepMs).toBe(300_000);
  });
});

describe("GET /api/projects/:id/services", () => {
  let api = { id: "", secretKey: "" };

  beforeAll(async () => {
    api = await newProject("API");
    const trace = hex(16);
    const span = (name: string, durationMs: number, extra: object = {}) => {
      const start = at("10:00:00") + BigInt(Math.floor(Math.random() * 1000)) * MS;
      return {
        traceId: trace,
        spanId: hex(8),
        parentSpanId: "",
        name,
        kind: 2,
        startTimeUnixNano: String(start),
        endTimeUnixNano: String(start + BigInt(durationMs) * MS),
        attributes: [],
        status: { code: 0 },
        ...extra,
      };
    };
    const route = keyValues({ "http.route": "/orders/{id}" });
    const web = [
      span("GET /orders/{id}", 10, { attributes: route }),
      span("GET /orders/{id}", 20, { attributes: route }),
      span("GET /orders/{id}", 30, { attributes: route, status: { code: 2 } }),
      span("GET /orders/{id}", 40, { attributes: route }),
      // No route: its name.
      span("GET /health", 5),
      // A client span is not a request the service answered.
      span("SELECT orders", 7, { kind: 3 }),
    ];
    const billing = [span("POST /charge", 100, { status: { code: 2 } })];
    // Sent once: the page reads without FINAL, so a retried copy not yet
    // merged away would count twice ("a retried batch not yet merged" in
    // telemetry-services.test.ts).
    await send("/v1/traces", api.secretKey, {
      resourceSpans: [
        {
          resource: { attributes: keyValues({ "service.name": "web" }) },
          scopeSpans: [{ spans: web }],
        },
        {
          resource: { attributes: keyValues({ "service.name": "billing" }) },
          scopeSpans: [{ spans: billing }],
        },
      ],
    });
  });

  test("gives each service's and route's requests, failures, median, and 95th percentile", async () => {
    const list = await getJson(api.id, `/services?${DAY}`);
    expect(list).toMatchObject({ received: true, truncated: false, environment: "production" });
    // Busiest first. Percentiles interpolate between the two nearest
    // durations: of 10, 20, 30, 40 ms, the median is 25 ms, the 95th
    // percentile 30 + 0.85 × 10 = 38.5 ms, and the 99th 30 + 0.97 × 10 =
    // 39.7 ms; with the 5 ms health check, 20, 30 + 0.8 × 10 = 38 ms, and
    // 30 + 0.96 × 10 = 39.6 ms. No span has a status code: all "none".
    expect(list.services).toEqual([
      {
        service: "web",
        requests: 5,
        failed: 1,
        p50Us: 20_000,
        p95Us: 38_000,
        p99Us: 39_600,
        statuses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, none: 5 },
        routeCount: 2,
        routes: [
          {
            route: "/orders/{id}",
            requests: 4,
            failed: 1,
            p50Us: 25_000,
            p95Us: 38_500,
            p99Us: 39_700,
            statuses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, none: 4 },
          },
          {
            route: "GET /health",
            requests: 1,
            failed: 0,
            p50Us: 5000,
            p95Us: 5000,
            p99Us: 5000,
            statuses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, none: 1 },
          },
        ],
      },
      {
        service: "billing",
        requests: 1,
        failed: 1,
        p50Us: 100_000,
        p95Us: 100_000,
        p99Us: 100_000,
        statuses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, none: 1 },
        routeCount: 1,
        routes: [
          {
            route: "POST /charge",
            requests: 1,
            failed: 1,
            p50Us: 100_000,
            p95Us: 100_000,
            p99Us: 100_000,
            statuses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, none: 1 },
          },
        ],
      },
    ]);
  });

  test("says when the project has never sent a span", async () => {
    const quiet = await newProject("Quiet services");
    expect(await getJson(quiet.id, `/services?${DAY}`)).toMatchObject({
      services: [],
      received: false,
    });
    expect(await getJson(api.id, `/services?${DAY}&environment=test`)).toMatchObject({
      services: [],
      received: true,
    });
  });
});

describe("access", () => {
  test("a project that does not exist gets 404; another project reads nothing of this one's", async () => {
    const missing = randomUUID();
    const paths = [
      `/metrics?${DAY}`,
      `/metrics/chart?${DAY}&name=process.memory&kind=gauge`,
      `/services?${DAY}`,
    ];
    expect(await statuses(shop.id, paths)).toEqual(all(paths, 200));
    expect(await statuses(missing, paths)).toEqual(all(paths, 404));
    for (const path of paths) {
      expect((await get(missing, path)).json()).toEqual({
        error: "not_found",
        message: "No project has this ID.",
      });
    }
    // Another project is empty: the ID in a path reaches only the project named.
    const other = await insertProject(dashboard.db, { name: "Another site" });
    const own = await get(other.id, `/metrics/chart?${DAY}&name=process.memory&kind=gauge`);
    expect(own.json()).toMatchObject({ series: [], seriesCount: 0 });
    expect((await get(other.id, `/metrics?${DAY}`)).json()).toMatchObject({
      metrics: [],
      received: false,
    });
  });

  test("needs a session", async () => {
    const response = await dashboard.app.inject({ url: `/api/projects/${shop.id}/metrics` });
    expect(response.statusCode).toBe(401);
  });
});
