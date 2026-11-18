import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { latestWindows, staleness } from "../src/telemetry/hosts.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { keyValues, secretKeyOf } from "./helpers/telemetry.ts";

/**
 * The Hosts pages (docs/telemetry.md, "Hosts"): host metrics as an
 * OpenTelemetry Collector's host metrics receiver sends them, from two
 * hosts, read back as the list and one host's charts. Every point is sent
 * twice, as a retry would, so a copy counted twice shows.
 */

const MS = 1_000_000n;
/** Yesterday, in UTC (the instance's timezone): every chart reads it, in 5-minute buckets. */
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const DAY = `from=${YESTERDAY}&to=${YESTERDAY}`;
/** Yesterday at a time of day, in milliseconds since 1970. */
const msAt = (time: string) => Date.parse(`${YESTERDAY}T${time}Z`);
/** The dashboard's clock: yesterday at 10:20, so a host last seen at 10:19 is fresh. */
const NOW = new Date(msAt("10:20:00"));
/** The 5-minute bucket of a time of day: 10:00 is bucket 120. */
const bucketOf = (time: string) => {
  const [hours = 0, mins = 0] = time.split(":").map(Number);
  return Math.floor((hours * 60 + mins) / 5);
};
const GIB = 1024 ** 3;
const CUMULATIVE = 2;

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

/** Whole minutes from `from` to `to`, both included, as "10:05:00". */
function minutes(from: string, to: string): string[] {
  const times: string[] = [];
  for (let moment = msAt(from); moment <= msAt(to); moment += 60_000) {
    times.push(new Date(moment).toISOString().slice(11, 19));
  }
  return times;
}

/** Minutes since 09:00, when every cumulative series here started. */
const sinceStart = (time: string) => (msAt(time) - msAt("09:00:00")) / 60_000;

interface Series {
  attributes?: Record<string, string>;
  /** The value at a time. */
  value: (time: string) => number;
}

const points = (times: string[], series: Series[]) =>
  series.flatMap((one) =>
    times.map((time) => ({
      timeUnixNano: String(BigInt(msAt(time)) * MS),
      startTimeUnixNano: String(BigInt(msAt("09:00:00")) * MS),
      attributes: keyValues(one.attributes ?? {}),
      asDouble: one.value(time),
    })),
  );

const gauge = (name: string, unit: string, times: string[], series: Series[]) => ({
  name,
  unit,
  gauge: { dataPoints: points(times, series) },
});

const sum = (
  name: string,
  unit: string,
  monotonic: boolean,
  times: string[],
  series: Series[],
) => ({
  name,
  unit,
  sum: {
    aggregationTemporality: CUMULATIVE,
    isMonotonic: monotonic,
    dataPoints: points(times, series),
  },
});

/** A steady counter: `perMinute` more each minute since 09:00. */
const counting = (perMinute: number, attributes: Record<string, string>): Series => ({
  attributes,
  value: (time) => perMinute * sinceStart(time),
});

const steady = (value: number, attributes: Record<string, string> = {}): Series => ({
  attributes,
  value: () => value,
});

/** The scraper of the host metrics receiver that sends a metric. */
const scraperOf = (name: string) =>
  name.startsWith("system.cpu.load_average")
    ? "load"
    : (/^system\.(cpu|memory|filesystem|network|disk)\./.exec(name)?.[1] ?? "cpu");

/**
 * The scope a host metrics receiver's scraper sends under: its Go
 * package's path now ("new"), "otelcol/hostmetricsreceiver/<scraper>" in
 * older releases ("old").
 */
const RECEIVER_SCOPE = {
  new: (scraper: string) =>
    `github.com/open-telemetry/opentelemetry-collector-contrib/receiver/hostmetricsreceiver/internal/scraper/${scraper}scraper`,
  old: (scraper: string) => `otelcol/hostmetricsreceiver/${scraper}`,
};

/**
 * Sends each resource's metrics twice, as a retry after a lost answer
 * would: each metric under its receiver scraper's scope ("new" by
 * default, or "old"), or all under a scope named outright, as an SDK's.
 */
async function sendMetrics(
  secretKey: string,
  resources: {
    attributes: Record<string, string>;
    metrics: { name: string }[];
    scope?: "new" | "old" | { name: string };
  }[],
) {
  const body = JSON.stringify({
    resourceMetrics: resources.map((resource) => {
      const style = resource.scope ?? "new";
      const scopes = new Map<string, object[]>();
      for (const metric of resource.metrics) {
        const scope =
          typeof style === "object" ? style.name : RECEIVER_SCOPE[style](scraperOf(metric.name));
        scopes.set(scope, [...(scopes.get(scope) ?? []), metric]);
      }
      return {
        resource: { attributes: keyValues(resource.attributes) },
        scopeMetrics: [...scopes].map(([name, metrics]) => ({ scope: { name }, metrics })),
      };
    }),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await dashboard.app.inject({
      method: "POST",
      url: "/v1/metrics",
      headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}` },
      payload: body,
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 200,
      body: {},
    });
  }
}

async function newProject(name: string) {
  const project = await insertProject(dashboard.db, {
    name,
  });
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

/** A value as the tests compare them: 4 decimals. */
const rounded = (value: number | null | undefined) =>
  value === null || value === undefined ? value : Math.round(value * 10_000) / 10_000;

interface Line {
  value: string | null;
  other: boolean;
  values: (number | null)[];
}
interface Chart {
  id: string;
  unit: string;
  metrics: string[];
  lines: Line[];
  capped: boolean;
}

/** One host's charts for yesterday, by ID. */
async function chartsOf(projectId: string, host: string): Promise<Record<string, Chart>> {
  const answer = await getJson(projectId, `/hosts/charts?${DAY}&host=${encodeURIComponent(host)}`);
  return Object.fromEntries(answer.charts.map((chart: Chart) => [chart.id, chart]));
}

/** Each line's values at the buckets of these times, rounded. */
const linesAt = (chart: Chart | undefined, times: string[]) =>
  Object.fromEntries(
    (chart?.lines ?? []).map((line) => [
      line.other ? "(other)" : String(line.value),
      times.map((time) => rounded(line.values[bucketOf(time)])),
    ]),
  );

let shop = { id: "", secretKey: "" };

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW });
  shop = await newProject("Shop");
  const web = minutes("10:00:00", "10:19:00");
  const db = minutes("10:00:00", "10:10:00");
  await sendMetrics(shop.secretKey, [
    {
      // web-1: two CPUs, the default metrics only (no utilization).
      attributes: { "host.name": "web-1", "os.type": "linux" },
      metrics: [
        // Each minute: cpu 0 is 15 s user, 3 s system, 42 s idle (30% busy);
        // cpu 1 is 9 s user, 51 s idle (15% busy). Together, 27 of 120 s: 22.5%.
        sum("system.cpu.time", "s", true, web, [
          counting(15, { cpu: "cpu0", state: "user" }),
          counting(3, { cpu: "cpu0", state: "system" }),
          counting(42, { cpu: "cpu0", state: "idle" }),
          counting(9, { cpu: "cpu1", state: "user" }),
          counting(0, { cpu: "cpu1", state: "system" }),
          counting(51, { cpu: "cpu1", state: "idle" }),
        ]),
        // Used 4 GiB of 4 + 2 + 0.5 + 1.5 = 8 GiB (the slab is within the others): 50%.
        sum("system.memory.usage", "By", false, web, [
          steady(4 * GIB, { state: "used" }),
          steady(2 * GIB, { state: "free" }),
          steady(0.5 * GIB, { state: "buffered" }),
          steady(1.5 * GIB, { state: "cached" }),
          steady(0.25 * GIB, { state: "slab_reclaimable" }),
          steady(0.25 * GIB, { state: "slab_unreclaimable" }),
        ]),
        // "/": 60 of 60 + 30 + 10 GiB, 60%; "/data": 90 of 100 GiB, 90%, the
        // fullest. A snap's read-only image is always full: left out.
        sum("system.filesystem.usage", "By", false, web, [
          steady(60 * GIB, { device: "sda1", mode: "rw", mountpoint: "/", state: "used" }),
          steady(30 * GIB, { device: "sda1", mode: "rw", mountpoint: "/", state: "free" }),
          steady(10 * GIB, { device: "sda1", mode: "rw", mountpoint: "/", state: "reserved" }),
          steady(90 * GIB, { device: "sdb1", mode: "rw", mountpoint: "/data", state: "used" }),
          steady(10 * GIB, { device: "sdb1", mode: "rw", mountpoint: "/data", state: "free" }),
          steady(0.1 * GIB, {
            device: "loop3",
            mode: "ro",
            mountpoint: "/snap/core22/1380",
            type: "squashfs",
            state: "used",
          }),
          steady(0, {
            device: "loop3",
            mode: "ro",
            mountpoint: "/snap/core22/1380",
            type: "squashfs",
            state: "free",
          }),
        ]),
        // 6,000 bytes in and 12,000 out a minute: 100 and 200 a second.
        sum("system.network.io", "By", true, web, [
          counting(6000, { device: "eth0", direction: "receive" }),
          counting(12_000, { device: "eth0", direction: "transmit" }),
        ]),
        // 1.5 until 10:15, then 0.75: the latest is 0.75.
        gauge("system.cpu.load_average.1m", "{thread}", web, [
          { value: (time) => (msAt(time) < msAt("10:15:00") ? 1.5 : 0.75) },
        ]),
      ],
    },
    {
      // db-1: last seen at 10:10, so stale at 10:20; sends the utilization
      // metrics too, from an older Collector (its scopes' older names).
      attributes: { "host.name": "db-1" },
      scope: "old",
      metrics: [
        // Half its time busy by cpu.time, but its utilization says 25%, and is preferred.
        sum("system.cpu.time", "s", true, db, [
          counting(30, { state: "user" }),
          counting(30, { state: "idle" }),
        ]),
        // The semantic conventions' key, cpu.mode, in place of the receiver's state.
        gauge("system.cpu.utilization", "1", db, [
          steady(0.25, { "cpu.mode": "user" }),
          steady(0.75, { "cpu.mode": "idle" }),
        ]),
        // 25% by usage, 80% by utilization, which is preferred.
        sum("system.memory.usage", "By", false, db, [
          steady(1 * GIB, { state: "used" }),
          steady(3 * GIB, { state: "free" }),
        ]),
        gauge("system.memory.utilization", "1", db, [
          steady(0.8, { state: "used" }),
          steady(0.2, { state: "free" }),
        ]),
        // 10% by usage, 42% by utilization (the receiver's has no state).
        sum("system.filesystem.usage", "By", false, db, [
          steady(10 * GIB, { mountpoint: "/", state: "used" }),
          steady(90 * GIB, { mountpoint: "/", state: "free" }),
        ]),
        gauge("system.filesystem.utilization", "1", db, [steady(0.42, { mountpoint: "/" })]),
        gauge("system.cpu.load_average.1m", "{thread}", db, [steady(2)]),
      ],
    },
    {
      // An app's own CPU time, from an SDK on a host without host.name: not a host.
      attributes: { "service.name": "checkout" },
      metrics: [sum("system.cpu.time", "s", true, web, [counting(60, { state: "user" })])],
    },
    // An app's host metrics from OpenTelemetry's JavaScript SDK, whose host
    // detector sets host.name: on web-1 itself (all busy, 16 GiB used) and
    // on app-1, where no Collector runs. Neither is the receiver's.
    ...["web-1", "app-1"].map((host) => ({
      attributes: { "host.name": host, "service.name": "checkout" },
      scope: { name: "@opentelemetry/host-metrics" },
      metrics: [
        sum("system.cpu.time", "s", true, web, [counting(60, { "system.cpu.state": "user" })]),
        sum("system.memory.usage", "By", false, web, [
          steady(16 * GIB, { "system.memory.state": "used" }),
        ]),
      ],
    })),
    // upgraded-1: an older Collector until 10:05 (1 GiB used of 4), a newer
    // one after (3 GiB of 4). The latest per state is the newer's: 75%,
    // where adding up both series' would give (1 + 3) of 8, 50%.
    {
      attributes: { "host.name": "upgraded-1" },
      scope: "old",
      metrics: [
        sum("system.memory.usage", "By", false, minutes("10:00:00", "10:04:00"), [
          steady(1 * GIB, { state: "used" }),
          steady(3 * GIB, { state: "free" }),
        ]),
      ],
    },
    {
      attributes: { "host.name": "upgraded-1" },
      metrics: [
        sum("system.memory.usage", "By", false, minutes("10:05:00", "10:10:00"), [
          steady(3 * GIB, { state: "used" }),
          steady(1 * GIB, { state: "free" }),
        ]),
      ],
    },
  ]);
});

afterAll(async () => {
  await dashboard?.close();
});

describe("the hosts list", () => {
  test("lists each host with its latest CPU, memory, fullest filesystem, and load", async () => {
    const list = await getJson(shop.id, `/hosts?${DAY}`);
    expect(list).toMatchObject({ received: true, truncated: false, environment: "production" });
    const hosts = list.hosts.map((host: Record<string, unknown>) => ({
      ...host,
      cpuPercent: rounded(host.cpuPercent as number | null),
      memoryPercent: rounded(host.memoryPercent as number | null),
      filesystemPercent: rounded(host.filesystemPercent as number | null),
      load1m: rounded(host.load1m as number | null),
    }));
    expect(hosts).toEqual([
      {
        host: "db-1",
        lastSeen: new Date(msAt("10:10:00")).toISOString(),
        // 10 minutes before the dashboard's now: more than 5.
        stale: true,
        // The utilization metrics, preferred: 1 − 0.75 idle; used 0.8; "/" at 0.42.
        cpuPercent: 25,
        memoryPercent: 80,
        filesystemPercent: 42,
        filesystemMount: "/",
        load1m: 2,
      },
      {
        host: "upgraded-1",
        lastSeen: new Date(msAt("10:10:00")).toISOString(),
        stale: true,
        cpuPercent: null,
        // The newer Collector's latest values only.
        memoryPercent: 75,
        filesystemPercent: null,
        filesystemMount: null,
        load1m: null,
      },
      {
        host: "web-1",
        lastSeen: new Date(msAt("10:19:00")).toISOString(),
        stale: false,
        // From the last two points of system.cpu.time: 27 of 120 s not idle
        // (the SDK's series on the same host left out).
        cpuPercent: 22.5,
        // 4 GiB used of 8 GiB (the slab's states left out).
        memoryPercent: 50,
        // Not the snap's read-only image at 100%.
        filesystemPercent: 90,
        filesystemMount: "/data",
        load1m: 0.75,
      },
    ]);
  });

  test("says when the project has never sent host metrics", async () => {
    const quiet = await newProject("Quiet hosts");
    // Metrics without host.name are not a host's, nor an SDK's with one.
    await sendMetrics(quiet.secretKey, [
      {
        attributes: { "service.name": "checkout" },
        metrics: [gauge("system.cpu.load_average.1m", "{thread}", ["10:00:00"], [steady(1)])],
      },
      {
        attributes: { "service.name": "checkout", "host.name": "app-1" },
        scope: { name: "@opentelemetry/host-metrics" },
        metrics: [
          sum(
            "system.cpu.time",
            "s",
            true,
            ["10:00:00", "10:01:00"],
            [counting(60, { "system.cpu.state": "user" })],
          ),
        ],
      },
    ]);
    expect(await getJson(quiet.id, `/hosts?${DAY}`)).toMatchObject({
      hosts: [],
      received: false,
    });
    // Another environment: none there, but the project has sent some.
    expect(await getJson(shop.id, `/hosts?${DAY}&environment=staging`)).toMatchObject({
      hosts: [],
      received: true,
    });
  });
});

describe("a host's charts", () => {
  test("charts web-1 from the default metrics, worked out by hand", async () => {
    const answer = await getJson(shop.id, `/hosts/charts?${DAY}&host=web-1`);
    expect(answer).toMatchObject({
      host: "web-1",
      lastSeen: new Date(msAt("10:19:00")).toISOString(),
      stale: false,
      stepSeconds: 300,
      // Yesterday's buckets up to the dashboard's now, 10:20.
      buckets: bucketOf("10:20"),
    });
    const charts = await chartsOf(shop.id, "web-1");
    const times = ["10:00", "10:05", "10:15"];
    // Busy: (15 + 3 + 9) / 120 = 22.5% in every bucket, whatever share of
    // a bucket's minutes its points cover; the states' shares: user
    // (15 + 9) / 120 = 20%, system 3 / 120 = 2.5%, idle 93 / 120 = 77.5%.
    expect(charts.cpu).toMatchObject({ unit: "%", metrics: ["system.cpu.time"], capped: false });
    expect(linesAt(charts.cpu, times)).toEqual({ null: [22.5, 22.5, 22.5] });
    expect(linesAt(charts.cpuStates, times)).toEqual({
      idle: [77.5, 77.5, 77.5],
      user: [20, 20, 20],
      system: [2.5, 2.5, 2.5],
    });
    // The first points count from their start, 09:00; nothing before it: no value, not 0.
    expect(charts.cpu?.lines[0]?.values[bucketOf("08:55")]).toBeNull();
    // Memory: used 4 GiB of 8 GiB.
    expect(charts.memoryPercent?.metrics).toEqual(["system.memory.usage"]);
    expect(linesAt(charts.memoryPercent, times)).toEqual({ used: [50, 50, 50] });
    expect(linesAt(charts.memoryBytes, times)).toEqual({ used: [4 * GIB, 4 * GIB, 4 * GIB] });
    // Filesystems: "/" 60%, "/data" 90%.
    expect(charts.filesystem?.metrics).toEqual(["system.filesystem.usage"]);
    expect(linesAt(charts.filesystem, times)).toEqual({ "/": [60, 60, 60], "/data": [90, 90, 90] });
    // Network: 100 B/s in, 200 out, in the buckets its points cover whole
    // (10:15–10:20 holds four minutes of increase over five minutes: 80 and 160).
    expect(charts.network?.unit).toBe("By/s");
    expect(linesAt(charts.network, ["10:05", "10:10", "10:15"])).toEqual({
      transmit: [200, 200, 160],
      receive: [100, 100, 80],
    });
    // The SDK's series on web-1 are not the host's either: memory stays 4 GiB, CPU 22.5%.
    // No disk metrics: no lines.
    expect(charts.disk).toMatchObject({ metrics: [], lines: [] });
    // Load: 1.5, then 0.75 from 10:15.
    expect(charts.load?.metrics).toEqual(["system.cpu.load_average.1m"]);
    expect(linesAt(charts.load, ["10:10", "10:15"])).toEqual({
      "system.cpu.load_average.1m": [1.5, 0.75],
    });
  });

  test("prefers the utilization metrics when they are sent, and reads only the host asked for", async () => {
    const charts = await chartsOf(shop.id, "db-1");
    const times = ["10:00", "10:05"];
    expect(charts.cpu?.metrics).toEqual(["system.cpu.utilization"]);
    // 1 − 0.75 idle; the shares by cpu.mode.
    expect(linesAt(charts.cpu, times)).toEqual({ null: [25, 25] });
    expect(linesAt(charts.cpuStates, times)).toEqual({ idle: [75, 75], user: [25, 25] });
    expect(charts.memoryPercent?.metrics).toEqual(["system.memory.utilization"]);
    expect(linesAt(charts.memoryPercent, times)).toEqual({ used: [80, 80] });
    // Bytes are db-1's 1 GiB, not added to web-1's 4.
    expect(linesAt(charts.memoryBytes, times)).toEqual({ used: [GIB, GIB] });
    expect(charts.filesystem?.metrics).toEqual(["system.filesystem.utilization"]);
    expect(linesAt(charts.filesystem, times)).toEqual({ "/": [42, 42] });
    // web-1's network is not db-1's.
    expect(charts.network?.lines).toEqual([]);
    expect(linesAt(charts.load, times)).toEqual({ "system.cpu.load_average.1m": [2, 2] });
  });

  test("an SDK's metrics under a host's name make no host", async () => {
    const answer = await getJson(shop.id, `/hosts/charts?${DAY}&host=app-1`);
    expect(answer).toMatchObject({ lastSeen: null });
    for (const chart of answer.charts) expect(chart.lines).toEqual([]);
  });

  test("a host with nothing in the period has no lines", async () => {
    const answer = await getJson(shop.id, `/hosts/charts?${DAY}&host=gone-1`);
    expect(answer).toMatchObject({ host: "gone-1", lastSeen: null, stale: true });
    for (const chart of answer.charts) expect(chart.lines).toEqual([]);
  });
});

describe("a long period", () => {
  test("reads each host's last minutes, not the period between, when one stopped early", async () => {
    const long = await newProject("Long period");
    // early-1 reported from 00:00 to 00:20 only: a quarter of its time busy.
    await sendMetrics(long.secretKey, [
      {
        attributes: { "host.name": "early-1" },
        metrics: [
          sum("system.cpu.time", "s", true, minutes("00:00:00", "00:20:00"), [
            counting(15, { state: "user" }),
            counting(45, { state: "idle" }),
          ]),
        ],
      },
    ]);
    // busy-1 reports until 10:19: 20 CPUs, a point every 6 seconds, from
    // midnight: 247,600 rows, written straight to ClickHouse for speed.
    await dashboard.reader.client.command({
      query: `INSERT INTO metric_points (project_id, timestamp, id, start_timestamp, name, unit,
                kind, temporality, monotonic, value, service, environment, resource_attributes,
                attributes, scope_name)
              SELECT {project:UUID}, toDateTime64({day:String}, 9, 'UTC') + toIntervalSecond(step * 6),
                     toString(number), toDateTime64({day:String}, 9, 'UTC'), 'system.cpu.time', 's',
                     'sum', 'cumulative', true, step * if(idle, 4.5, 1.5), 'unknown_service',
                     'production', map('host.name', 'busy-1'),
                     map('cpu', concat('cpu', toString(cpu)), 'state', if(idle, 'idle', 'user')),
                     {scope:String}
              FROM (SELECT number, intDiv(number, 40) AS step, intDiv(number % 40, 2) AS cpu,
                           number % 2 = 1 AS idle
                    FROM numbers(40 * 6190))`,
      query_params: {
        project: long.id,
        day: `${YESTERDAY} 00:00:00`,
        scope: RECEIVER_SCOPE.new("cpu"),
      },
    });
    const list = await getJson(long.id, `/hosts?${DAY}`);
    expect(
      list.hosts.map((host: { host: string; cpuPercent: number }) => [
        host.host,
        rounded(host.cpuPercent),
      ]),
    ).toEqual([
      ["busy-1", 25],
      ["early-1", 25],
    ]);
    // The latest values' query read the hosts' windows only: 15 minutes of
    // busy-1 (6,000 rows, in whole granules of 8,192) and early-1's, not
    // the 247,600 rows from 00:20 to 10:19.
    await dashboard.reader.client.command({ query: "SYSTEM FLUSH LOGS" });
    const [read] = await (
      await dashboard.reader.client.query({
        query: `SELECT read_rows FROM system.query_log
                WHERE type = 'QueryFinish' AND current_database = currentDatabase()
                  AND query LIKE '%groupArraySorted%' AND query NOT LIKE '%query_log%'
                ORDER BY event_time_microseconds DESC
                LIMIT 1`,
        format: "JSONEachRow",
      })
    ).json<{ read_rows: string }>();
    expect(Number(read?.read_rows)).toBeLessThan(40_000);
  });

  test("merges hosts' windows that overlap", () => {
    const range = { from: new Date(0) } as Parameters<typeof latestWindows>[0];
    const minute = 60_000;
    expect(latestWindows(range, [100 * minute, 105 * minute, 300 * minute])).toEqual([
      { startMs: 85 * minute, endMs: 105 * minute + 1 },
      { startMs: 285 * minute, endMs: 300 * minute + 1 },
    ]);
  });

  test("says nothing of staleness for a period that ended before now", () => {
    const range = { to: new Date(msAt("23:59:59")) } as Parameters<typeof staleness>[0];
    const seen = new Date(msAt("10:00:00"));
    expect(staleness(range, seen, new Date(msAt("10:02:00")))).toBe(false);
    expect(staleness(range, seen, new Date(msAt("10:06:00")))).toBe(true);
    expect(staleness(range, seen, new Date(Date.parse(`${YESTERDAY}T23:59:59Z`) + 1))).toBe(null);
  });
});

describe("a failed query", () => {
  test("ends its request's other queries, so they free their places", async () => {
    const client = dashboard.reader.client;
    const original = client.query.bind(client);
    let answered = false;
    let startedAfter = 0;
    let active = 0;
    let started = 0;
    // The CPU chart's query fails at once; every other waits 100 ms first.
    client.query = async (params: Parameters<typeof original>[0]) => {
      started += 1;
      if (answered) startedAfter += 1;
      active += 1;
      try {
        if (Object.values(params.query_params ?? {}).includes("system.cpu.utilization")) {
          throw new Error("failed on purpose");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return await original(params);
      } finally {
        active -= 1;
      }
    };
    try {
      // Over a real connection, as a browser's: an injected request's
      // reply closes unfinished, which hides whether a sent answer ends the rest.
      const address = await dashboard.app.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(
        `${address}/api/projects/${shop.id}/hosts/charts?${DAY}&host=web-1`,
        { headers: { cookie: dashboard.cookie } },
      );
      answered = true;
      expect(response.status).toBe(500);
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The two that had places, and the one the failure handed its place
      // to before the answer, ended; none of the rest of the 11 started.
      expect({ startedAfter, active }).toEqual({ startedAfter: 0, active: 0 });
      expect(started).toBeLessThanOrEqual(3);
    } finally {
      client.query = original;
    }
  });
});

describe("parameters", () => {
  test("refuses bad ones", async () => {
    const bad = [
      `/hosts/charts?${DAY}`,
      `/hosts/charts?${DAY}&host=`,
      `/hosts/charts?${DAY}&host=${"h".repeat(4097)}`,
      // 2,049 characters of 2 bytes each: past the 4 KB a value is stored with.
      `/hosts/charts?${DAY}&host=${encodeURIComponent("é".repeat(2049))}`,
      `/hosts/charts?period=forever&host=web-1`,
      `/hosts?period=forever`,
    ];
    // Keyed by the path's start, so a failure stays readable.
    const answers: Record<string, number> = {};
    for (const path of bad) answers[path.slice(0, 120)] = (await get(shop.id, path)).statusCode;
    expect(answers).toEqual(Object.fromEntries(bad.map((path) => [path.slice(0, 120), 400])));
    expect(
      (
        await get(shop.id, `/hosts/charts?${DAY}&host=${encodeURIComponent("é".repeat(2049))}`)
      ).json(),
    ).toMatchObject({ error: "invalid_host" });
  });
});

describe("access", () => {
  test("a project that does not exist gets 404; another project reads nothing of this one's", async () => {
    const missing = randomUUID();
    const paths = [`/hosts?${DAY}`, `/hosts/charts?${DAY}&host=web-1`];
    for (const path of paths) {
      expect((await get(shop.id, path)).statusCode).toBe(200);
      const answer = await get(missing, path);
      expect({ status: answer.statusCode, body: answer.json() }).toEqual({
        status: 404,
        body: { error: "not_found", message: "No project has this ID." },
      });
    }
    // Another project names the same host and reads nothing of this one's.
    const other = await insertProject(dashboard.db, { name: "Another site" });
    expect((await get(other.id, `/hosts?${DAY}`)).json()).toMatchObject({
      hosts: [],
      received: false,
    });
    const charts = (await get(other.id, `/hosts/charts?${DAY}&host=web-1`)).json();
    expect(charts).toMatchObject({ lastSeen: null });
    for (const chart of charts.charts) expect(chart.lines).toEqual([]);
  });

  test("needs a session", async () => {
    const response = await dashboard.app.inject({ url: `/api/projects/${shop.id}/hosts` });
    expect(response.statusCode).toBe(401);
  });
});
