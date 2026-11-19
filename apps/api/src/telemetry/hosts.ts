import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  DASHBOARD_SETTINGS,
  dateOfNs,
  labelsInRange,
  type TelemetryRange,
} from "./dashboard-query.ts";
import {
  bucketsOf,
  type ChartOptions,
  type ChartSeries,
  firstAttribute,
  type MetricChart,
  metricChart,
} from "./metrics.ts";

/**
 * The dashboard's Hosts pages (docs/telemetry.md, "Hosts"): the machines
 * an OpenTelemetry Collector's host metrics receiver reports on, told
 * apart by their resource's `host.name`, with their latest CPU, memory,
 * filesystem, and load; and one host's charts over the period.
 *
 * Only the receiver's metrics count: those of an instrumentation scope it
 * names (RECEIVER_SCOPES). An app's SDK may send metrics of the same names
 * under the same host.name; they are not the host's.
 *
 * Every chart comes from the metric tables as metrics.ts reads them,
 * filtered by the host's name: rates from cumulative sums with resets,
 * gauges, up-down counters. A utilization metric (a gauge of shares from
 * 0 to 1) is preferred when the receiver sends it; it is off by default,
 * so the shares are otherwise worked out from the default metrics.
 */

/** The resource attribute that names a host (OpenTelemetry's semantic conventions). */
export const HOST_KEY = "host.name";

/**
 * The start of the scope name each of the host metrics receiver's scrapers
 * sends under: "otelcol/hostmetricsreceiver/cpu" in older releases (v0.80.0),
 * the scraper's Go package path now (".../internal/scraper/cpuscraper").
 */
export const RECEIVER_SCOPES = [
  "otelcol/hostmetricsreceiver/",
  "github.com/open-telemetry/opentelemetry-collector-contrib/receiver/hostmetricsreceiver/",
] as const;

/** The metrics the pages read, as the host metrics receiver names them. */
export const HOST_METRICS = {
  cpuTime: "system.cpu.time",
  cpuUtilization: "system.cpu.utilization",
  memoryUsage: "system.memory.usage",
  memoryUtilization: "system.memory.utilization",
  filesystemUsage: "system.filesystem.usage",
  filesystemUtilization: "system.filesystem.utilization",
  networkIo: "system.network.io",
  diskIo: "system.disk.io",
  load1m: "system.cpu.load_average.1m",
  load5m: "system.cpu.load_average.5m",
  load15m: "system.cpu.load_average.15m",
} as const;

/** Any of these from a resource with a host.name, in the receiver's scope, makes it a host. */
const HOST_METRIC_NAMES: readonly string[] = Object.values(HOST_METRICS);

/** What the list's latest values read: neither network, disk, nor the longer load averages. */
const LIST_METRIC_NAMES: readonly string[] = [
  HOST_METRICS.cpuTime,
  HOST_METRICS.cpuUtilization,
  HOST_METRICS.memoryUsage,
  HOST_METRICS.memoryUtilization,
  HOST_METRICS.filesystemUsage,
  HOST_METRICS.filesystemUtilization,
  HOST_METRICS.load1m,
];

/**
 * Attribute keys, the receiver's first, then the semantic conventions'
 * (which the receiver may move to), then older names: the first a point
 * has is read.
 */
const CPU_STATE_KEYS = ["state", "cpu.mode", "system.cpu.state"];
const MEMORY_STATE_KEYS = ["state", "system.memory.state"];
const FILESYSTEM_STATE_KEYS = ["state", "system.filesystem.state"];
const STATE_KEYS = [
  ...new Set([...CPU_STATE_KEYS, ...MEMORY_STATE_KEYS, ...FILESYSTEM_STATE_KEYS]),
];
const MOUNT_KEYS = ["mountpoint", "system.filesystem.mountpoint"];
const MODE_KEYS = ["mode", "system.filesystem.mode"];
const NETWORK_DIRECTION_KEYS = ["direction", "network.io.direction"];
const DISK_DIRECTION_KEYS = ["direction", "disk.io.direction"];

/** A filesystem mounted read-only, such as a snap's squashfs: always full, never filling. */
const READ_ONLY = "ro";

/** Memory states that are parts of other states (the kernel's slab is within used or cached). */
const MEMORY_PARTS = ["slab_reclaimable", "slab_unreclaimable"];

/** Hosts the list holds, by name; past this, it says it was cut. */
export const MAX_HOSTS = 500;
/** A host that sent nothing for this long is stale. */
export const STALE_MS = 5 * 60_000;
/**
 * The list's latest values come from each host's points in this long
 * before its last one: a counter needs two points, and the host's last
 * point may be another scraper's, one interval after the CPU's, so up to
 * 7.5 minutes between scrapes still gives a CPU share.
 */
export const LATEST_WINDOW_MS = 15 * 60_000;

export interface HostSummary {
  host: string;
  lastSeen: Date;
  /**
   * Nothing from it in the STALE_MS before now; null when the period ended
   * before now, which says nothing about the host now.
   */
  stale: boolean | null;
  /** 0 to 100, or null when it sent nothing to work it out from. */
  cpuPercent: number | null;
  memoryPercent: number | null;
  /** The fullest filesystem's used share (read-only ones left out), and its mount point. */
  filesystemPercent: number | null;
  filesystemMount: string | null;
  /** The 1-minute load average. */
  load1m: number | null;
}

/** Only the host metrics receiver's series (RECEIVER_SCOPES). */
function receiverScope(params: QueryParams): string {
  return `(${RECEIVER_SCOPES.map(
    (prefix) => `startsWith(scope_name, ${params.add(prefix, "String")})`,
  ).join(" OR ")})`;
}

/** The project's rows of host metrics `names` in the environment, from the receiver, in a time condition. */
function hostRows(
  params: QueryParams,
  range: TelemetryRange,
  time: string,
  names: readonly string[] = HOST_METRIC_NAMES,
): string {
  return `project_id = ${params.add(range.projectId, "UUID")}
    AND name IN ${params.add(names, "Array(String)")}
    AND ${time}
    AND environment = ${params.add(range.environment, "String")}
    AND ${receiverScope(params)}`;
}

const inRange = (params: QueryParams, range: TelemetryRange) =>
  `timestamp >= ${params.time(range.from)} AND timestamp < ${params.time(range.to)}`;

const hostOf = (params: QueryParams) => `resource_attributes[${params.add(HOST_KEY, "String")}]`;

/** Whether a host last seen then is stale now; null when the range ended before now. */
export function staleness(range: TelemetryRange, lastSeen: Date | null, now: Date): boolean | null {
  if (range.to.getTime() <= now.getTime()) return null;
  return lastSeen === null || now.getTime() - lastSeen.getTime() > STALE_MS;
}

interface LatestRow {
  host: string;
  name: string;
  mount: string;
  /** A share from 0 to 1, or a load; null when it cannot be worked out. */
  value: number | null;
}

/** A latest share as a percentage. */
const percent = (row: LatestRow | undefined) =>
  row === undefined || row.value === null ? null : row.value * 100;

/**
 * The hosts that sent host metrics in the range, by name, each with when
 * it was last seen and its latest values:
 *
 * - CPU busy: from system.cpu.utilization's latest point of each series,
 *   the share of the states that are not idle; else from system.cpu.time,
 *   each series' increase between its last two points (one run, no
 *   reset), the share of the time not idle;
 * - memory: system.memory.utilization's `used`; else system.memory.usage's
 *   `used` over all its states but the slab's, which are parts of others;
 * - the fullest filesystem: per mount point, system.filesystem.utilization
 *   (its `used` state when it has states), else system.filesystem.usage's
 *   `used` over all its states; the highest, read-only mounts left out;
 * - load: system.cpu.load_average.1m's latest point.
 *
 * Latest values read each host's last LATEST_WINDOW_MS of the range, FINAL,
 * so a retried point is not taken for the point before it.
 */
export async function listHosts(
  reader: Reader,
  range: TelemetryRange,
  now: Date,
): Promise<{
  hosts: HostSummary[];
  /** More than MAX_HOSTS hosts: the list holds the first by name. */
  truncated: boolean;
  environments: string[];
  /** Whether the project has sent any host metric with a host name at all: false shows how to. */
  received: boolean;
}> {
  const params = new QueryParams();
  const host = hostOf(params);
  const [found, labels] = await Promise.all([
    queryRows<{ host: string; last_ns: string }>(
      reader,
      `SELECT ${host} AS host, toString(toUnixTimestamp64Nano(max(timestamp))) AS last_ns
       FROM metric_points
       WHERE ${hostRows(params, range, inRange(params, range))} AND ${host} != ''
       GROUP BY host
       ORDER BY host
       LIMIT ${MAX_HOSTS + 1}`,
      params,
      DASHBOARD_SETTINGS,
    ),
    // The names and scopes are constants, never input.
    labelsInRange(
      reader,
      "metric_points",
      range,
      `AND name IN (${HOST_METRIC_NAMES.map((name) => `'${name}'`).join(", ")})
       AND (${RECEIVER_SCOPES.map((prefix) => `startsWith(scope_name, '${prefix}')`).join(" OR ")})`,
    ),
  ]);
  const listed = found.slice(0, MAX_HOSTS);
  const latest = listed.length === 0 ? [] : await latestValues(reader, range, listed);
  const valueOf = (hostName: string, name: string) =>
    latest.find((row) => row.host === hostName && row.name === name);
  const hosts = listed.map((row): HostSummary => {
    const lastSeen = dateOfNs(row.last_ns);
    /** The utilization metric's row when it has a value, else the fallback's. */
    const preferred = (utilization: string, fallback: string) => {
      const first = valueOf(row.host, utilization);
      return first !== undefined && first.value !== null ? first : valueOf(row.host, fallback);
    };
    const filesystem = preferred(HOST_METRICS.filesystemUtilization, HOST_METRICS.filesystemUsage);
    return {
      host: row.host,
      lastSeen,
      stale: staleness(range, lastSeen, now),
      cpuPercent: percent(preferred(HOST_METRICS.cpuUtilization, HOST_METRICS.cpuTime)),
      memoryPercent: percent(preferred(HOST_METRICS.memoryUtilization, HOST_METRICS.memoryUsage)),
      filesystemPercent: percent(filesystem),
      filesystemMount: filesystem?.value === null ? null : (filesystem?.mount ?? null),
      load1m: valueOf(row.host, HOST_METRICS.load1m)?.value ?? null,
    };
  });
  return {
    hosts,
    truncated: found.length > MAX_HOSTS,
    environments: labels.environments,
    received: hosts.length > 0 || (await anyHost(reader, range.projectId)),
  };
}

/** Whether the project has any host metric from a named host, within the retention. */
async function anyHost(reader: Reader, projectId: string): Promise<boolean> {
  const params = new QueryParams();
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM metric_points
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND name IN ${params.add(HOST_METRIC_NAMES, "Array(String)")}
       AND ${receiverScope(params)}
       AND ${hostOf(params)} != ''
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.length > 0;
}

/**
 * Each host's window, [LATEST_WINDOW_MS before its last point, just after
 * it], within the range, in milliseconds; overlapping windows merged, so
 * the condition on time names each stretch once.
 */
export function latestWindows(
  range: TelemetryRange,
  lastMs: readonly number[],
): { startMs: number; endMs: number }[] {
  const windows = lastMs
    .map((last) => ({
      startMs: Math.max(range.from.getTime(), last - LATEST_WINDOW_MS),
      // The last point's time in nanoseconds may lie within its millisecond.
      endMs: last + 1,
    }))
    .toSorted((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last !== undefined && window.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, window.endMs);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * Each listed host's latest values, one row per host and metric (the
 * fullest mount point's for filesystems), as listHosts describes them.
 *
 * The time condition is each host's own window (latestWindows), as ranges
 * of the sorting key, so a host that stopped early in a long period reads
 * its last minutes, not the period between; then each row is kept only
 * within its own host's window.
 */
async function latestValues(
  reader: Reader,
  range: TelemetryRange,
  listed: { host: string; last_ns: string }[],
): Promise<LatestRow[]> {
  const params = new QueryParams();
  const lastMs = listed.map((row) => dateOfNs(row.last_ns).getTime());
  const cutoffs = lastMs.map((last) => Math.max(range.from.getTime(), last - LATEST_WINDOW_MS));
  const windows = latestWindows(range, lastMs)
    .map(
      (window) =>
        `(timestamp >= ${params.time(new Date(window.startMs))} AND timestamp < ${params.time(new Date(window.endMs))})`,
    )
    .join(" OR ");
  const hosts = params.add(
    listed.map((row) => row.host),
    "Array(String)",
  );
  const host = hostOf(params);
  const name = (key: keyof typeof HOST_METRICS) => params.add(HOST_METRICS[key], "String");
  const state = firstAttribute(params, STATE_KEYS);
  const mount = firstAttribute(params, MOUNT_KEYS);
  const mode = firstAttribute(params, MODE_KEYS);
  const idle = params.add("idle", "String");
  const used = params.add("used", "String");
  const parts = params.add(MEMORY_PARTS, "Array(String)");
  const filesystems = `(${name("filesystemUsage")}, ${name("filesystemUtilization")})`;
  const cpus = `(${name("cpuTime")}, ${name("cpuUtilization")})`;
  return queryRows<LatestRow>(
    reader,
    // Per series: its last two points, latest first; the increase between
    // them when they are of one run and did not go down (a delta point's
    // value is its increase). Then per state: a CPU's series each apart
    // (one per CPU), any other metric's latest across its series, so the
    // old and new series of an upgraded Collector count once. Then per
    // host, metric, and mount point.
    `SELECT host, name, mount,
            multiIf(
              name = ${name("cpuUtilization")}, (total - idle_total) / nullIf(total, 0),
              name = ${name("cpuTime")}, (total_increase - idle_increase) / nullIf(total_increase, 0),
              name = ${name("memoryUsage")}, used_total / nullIf(whole_total, 0),
              name = ${name("filesystemUsage")}, used_total / nullIf(total, 0),
              name IN (${name("memoryUtilization")}, ${name("filesystemUtilization")}),
                if(with_state, used_total, highest),
              toNullable(highest)) AS value
     FROM (
       SELECT host, name, series_mount AS mount,
              sum(state_latest) AS total, max(state_latest) AS highest,
              sumIf(state_latest, series_state = ${idle}) AS idle_total,
              sumIf(state_latest, series_state = ${used}) AS used_total,
              sumIf(state_latest, series_state NOT IN ${parts}) AS whole_total,
              sum(state_increase) AS total_increase,
              sumIf(state_increase, series_state = ${idle}) AS idle_increase,
              countIf(series_state IS NOT NULL) > 0 AS with_state
       FROM (
         SELECT host, name, series_mount, series_state, part,
                argMax(series_latest, latest_ns) AS state_latest,
                argMax(series_increase, latest_ns) AS state_increase
         FROM (
           SELECT host, name, any(state) AS series_state, ifNull(any(mount), '') AS series_mount,
                  any(is_delta) AS delta, if(name IN ${cpus}, toString(series), '') AS part,
                  groupArraySorted(2)((-t_ns, value, start_ns)) AS last_two,
                  -last_two[1].1 AS latest_ns,
                  last_two[1].2 AS series_latest,
                  multiIf(delta, series_latest,
                          length(last_two) = 2 AND last_two[1].3 = last_two[2].3
                            AND series_latest >= last_two[2].2, series_latest - last_two[2].2,
                          0) AS series_increase
           FROM (
             SELECT ${host} AS host, name, series, ${state} AS state, ${mount} AS mount,
                    temporality = 'delta' AS is_delta, value,
                    toUnixTimestamp64Nano(timestamp) AS t_ns,
                    toUnixTimestamp64Nano(start_timestamp) AS start_ns
             FROM metric_points FINAL
             WHERE ${hostRows(params, range, `(${windows})`, LIST_METRIC_NAMES)}
               AND host IN ${hosts}
               AND toUnixTimestamp64Milli(timestamp)
                   >= transform(host, ${hosts}, ${params.add(cutoffs, "Array(Int64)")}, toInt64(0))
               AND NOT (name IN ${filesystems} AND ifNull(${mode}, '') = ${params.add(READ_ONLY, "String")})
           )
           GROUP BY host, name, series
         )
         GROUP BY host, name, series_mount, series_state, part
       )
       GROUP BY host, name, series_mount
     )
     ORDER BY host, name, value DESC NULLS LAST, mount
     LIMIT 1 BY host, name
     LIMIT ${MAX_HOSTS * LIST_METRIC_NAMES.length}`,
    params,
    DASHBOARD_SETTINGS,
  );
}

/** One line of a host's chart: a value per bucket, null where nothing arrived. */
export interface HostLine {
  /** What it stands for ("idle", "/", "receive", a load average's metric), or null for points without one. */
  value: string | null;
  /** Values past the chart's eight lines, added up (metrics.ts, SPLIT_LINES). */
  other: boolean;
  values: (number | null)[];
}

export const HOST_CHARTS = [
  "cpu",
  "cpuStates",
  "memoryPercent",
  "memoryBytes",
  "filesystem",
  "network",
  "disk",
  "load",
] as const;
export type HostChartId = (typeof HOST_CHARTS)[number];

export interface HostChart {
  id: HostChartId;
  /** "%" (0 to 100), "By", "By/s", or "{thread}". */
  unit: string;
  /** The metrics it was worked out from; empty when the host sent none of them. */
  metrics: string[];
  lines: HostLine[];
  /** A metric had more series than a chart reads (metrics.ts, MAX_SERIES). */
  capped: boolean;
}

export interface HostCharts {
  host: string;
  /** null: no host metric from it in the range. */
  lastSeen: Date | null;
  /** As HostSummary's: null when the range ended before now. */
  stale: boolean | null;
  start: Date;
  stepSeconds: number;
  buckets: number;
  charts: HostChart[];
}

type Values = (number | null)[];

/** Per bucket, `f` of the bucket's index. */
const perBucket = (count: number, f: (index: number) => number | null): Values =>
  Array.from({ length: count }, (_, index) => f(index));

/** The sum of the lines' values at a bucket; null when none has one. */
function sumAt(lines: readonly ChartSeries[], measure: string, index: number): number | null {
  let total: number | null = null;
  for (const line of lines) {
    const value = line.values[measure]?.[index];
    if (value !== null && value !== undefined) total = (total ?? 0) + value;
  }
  return total;
}

/** `part` over `whole` at each bucket, as a percentage; null without a whole above 0. */
function percentOf(
  count: number,
  part: (index: number) => number | null,
  whole: (index: number) => number | null,
): Values {
  return perBucket(count, (index) => {
    const total = whole(index);
    if (total === null || total <= 0) return null;
    return ((part(index) ?? 0) / total) * 100;
  });
}

const lineOf = (series: ChartSeries, values: Values): HostLine => ({
  value: series.value,
  other: series.other,
  values,
});

/** Whether any of the charts read fewer series than the metric has. */
const capped = (...charts: MetricChart[]) => charts.some((chart) => chart.seriesCapped);

/** The chart's metric, when it had any point. */
const metricsOf = (chart: MetricChart) => (chart.series.length === 0 ? [] : [chart.name]);

const named = (chart: MetricChart, value: string) =>
  chart.series.filter((series) => !series.other && series.value === value);

/**
 * One host's charts over the range, in the buckets metrics.ts uses, each
 * from metricChart with the host's filter, in one query each (`single`):
 *
 * - cpu: the busy share, 100 less idle's share of all states: of the
 *   average utilization per state (system.cpu.utilization), else of the
 *   time per second per state (system.cpu.time's rates, all CPUs added up);
 * - cpuStates: each state's share of the same;
 * - memoryPercent: system.memory.utilization's `used` (its average), else
 *   system.memory.usage's `used` over its states but the slab's;
 * - memoryBytes: system.memory.usage's `used`;
 * - filesystem: per mount point, read-only mounts left out,
 *   system.filesystem.utilization (its average; its `used` state when it
 *   has states), else system.filesystem.usage's `used` over all its states;
 * - network and disk: bytes per second by direction (system.network.io,
 *   system.disk.io), all interfaces or disks added up;
 * - load: the 1, 5, and 15-minute load averages, each bucket's average.
 *
 * At most 10 chart queries and one for when the host was last seen.
 */
export async function hostCharts(
  reader: Reader,
  range: TelemetryRange,
  host: string,
  now: Date,
): Promise<HostCharts> {
  const buckets = bucketsOf(range, now);
  const count = buckets.count;
  const chartOf = (options: ChartOptions) =>
    metricChart(
      reader,
      range,
      {
        ...options,
        resource: { key: HOST_KEY, value: host },
        scopePrefixes: RECEIVER_SCOPES,
        single: true,
      },
      now,
    );

  async function cpu(): Promise<HostChart[]> {
    let chart = await chartOf({
      name: HOST_METRICS.cpuUtilization,
      kind: "gauge",
      splitAny: CPU_STATE_KEYS,
    });
    let measure = "avg";
    if (chart.series.length === 0) {
      chart = await chartOf({
        name: HOST_METRICS.cpuTime,
        kind: "counter",
        splitAny: CPU_STATE_KEYS,
      });
      measure = "rate";
    }
    const whole = (index: number) => sumAt(chart.series, measure, index);
    const idle = named(chart, "idle");
    const busy = percentOf(
      count,
      (index) => {
        const total = whole(index);
        return total === null ? null : total - (sumAt(idle, measure, index) ?? 0);
      },
      whole,
    );
    return [
      {
        id: "cpu",
        unit: "%",
        metrics: metricsOf(chart),
        lines: chart.series.length === 0 ? [] : [{ value: null, other: false, values: busy }],
        capped: capped(chart),
      },
      {
        id: "cpuStates",
        unit: "%",
        metrics: metricsOf(chart),
        lines: chart.series.map((series) =>
          lineOf(
            series,
            percentOf(count, (index) => series.values[measure]?.[index] ?? null, whole),
          ),
        ),
        capped: capped(chart),
      },
    ];
  }

  async function memory(): Promise<HostChart[]> {
    const [usage, utilization] = await Promise.all([
      chartOf({ name: HOST_METRICS.memoryUsage, kind: "updown", splitAny: MEMORY_STATE_KEYS }),
      chartOf({
        name: HOST_METRICS.memoryUtilization,
        kind: "gauge",
        splitAny: MEMORY_STATE_KEYS,
      }),
    ]);
    const usedBytes = named(usage, "used");
    const bytes: HostChart = {
      id: "memoryBytes",
      unit: "By",
      metrics: metricsOf(usage),
      lines:
        usedBytes.length === 0
          ? []
          : [
              {
                value: "used",
                other: false,
                values: perBucket(count, (index) => sumAt(usedBytes, "sum", index)),
              },
            ],
      capped: capped(usage),
    };
    const usedShare = named(utilization, "used");
    if (usedShare.length > 0) {
      return [
        {
          id: "memoryPercent",
          unit: "%",
          metrics: metricsOf(utilization),
          lines: [
            {
              value: "used",
              other: false,
              values: perBucket(count, (index) => {
                const share = sumAt(usedShare, "avg", index);
                return share === null ? null : share * 100;
              }),
            },
          ],
          capped: capped(utilization),
        },
        bytes,
      ];
    }
    const whole = usage.series.filter(
      (series) => series.other || series.value === null || !MEMORY_PARTS.includes(series.value),
    );
    return [
      {
        id: "memoryPercent",
        unit: "%",
        metrics: bytes.metrics,
        lines:
          usedBytes.length === 0
            ? []
            : [
                {
                  value: "used",
                  other: false,
                  values: percentOf(
                    count,
                    (index) => sumAt(usedBytes, "sum", index),
                    (index) => sumAt(whole, "sum", index),
                  ),
                },
              ],
        capped: capped(usage),
      },
      bytes,
    ];
  }

  async function filesystem(): Promise<HostChart> {
    const readOnly = { keys: MODE_KEYS, value: READ_ONLY };
    // The receiver's utilization has no states; with states, as the
    // semantic conventions have it, only `used` is the share used.
    const utilization = await chartOf({
      name: HOST_METRICS.filesystemUtilization,
      kind: "gauge",
      splitAny: MOUNT_KEYS,
      attribute: { keys: FILESYSTEM_STATE_KEYS, value: "used", orMissing: true },
      exclude: readOnly,
    });
    if (utilization.series.length > 0) {
      return {
        id: "filesystem",
        unit: "%",
        metrics: metricsOf(utilization),
        lines: utilization.series.map((line) =>
          lineOf(
            line,
            (line.values.avg ?? []).map((value) => (value === null ? null : value * 100)),
          ),
        ),
        capped: capped(utilization),
      };
    }
    const [usedChart, wholeChart] = await Promise.all([
      chartOf({
        name: HOST_METRICS.filesystemUsage,
        kind: "updown",
        splitAny: MOUNT_KEYS,
        attribute: { keys: FILESYSTEM_STATE_KEYS, value: "used" },
        exclude: readOnly,
      }),
      chartOf({
        name: HOST_METRICS.filesystemUsage,
        kind: "updown",
        splitAny: MOUNT_KEYS,
        exclude: readOnly,
      }),
    ]);
    // Lines of the two charts are matched by their mount point (or both "other").
    const lines = usedChart.series.flatMap((used) => {
      const whole = wholeChart.series.find(
        (line) => line.other === used.other && line.value === used.value,
      );
      if (whole === undefined) return [];
      return [
        lineOf(
          used,
          percentOf(
            count,
            (index) => used.values.sum?.[index] ?? null,
            (index) => whole.values.sum?.[index] ?? null,
          ),
        ),
      ];
    });
    return {
      id: "filesystem",
      unit: "%",
      metrics: metricsOf(wholeChart),
      lines,
      capped: capped(usedChart, wholeChart),
    };
  }

  async function rates(
    id: "network" | "disk",
    name: string,
    keys: readonly string[],
  ): Promise<HostChart> {
    const chart = await chartOf({ name, kind: "counter", splitAny: keys });
    return {
      id,
      unit: "By/s",
      metrics: metricsOf(chart),
      lines: chart.series.map((series) => lineOf(series, series.values.rate ?? [])),
      capped: capped(chart),
    };
  }

  async function load(): Promise<HostChart> {
    const names = [HOST_METRICS.load1m, HOST_METRICS.load5m, HOST_METRICS.load15m];
    // The three in one query, a line per metric's name, shortest first.
    const chart = await chartOf({ name: HOST_METRICS.load1m, kind: "gauge", names });
    const lines = names.flatMap((name) => {
      const series = chart.series.find((line) => !line.other && line.value === name);
      return series === undefined ? [] : [lineOf(series, series.values.avg ?? [])];
    });
    return {
      id: "load",
      unit: "{thread}",
      metrics: lines.flatMap((line) => (line.value === null ? [] : [line.value])),
      lines,
      capped: capped(chart),
    };
  }

  const params = new QueryParams();
  const hostName = hostOf(params);
  const [seen, cpuCharts, memoryCharts, filesystemChart, network, disk, loadChart] =
    await Promise.all([
      queryRows<{ last_ns: string | null }>(
        reader,
        `SELECT if(count() = 0, NULL, toString(toUnixTimestamp64Nano(max(timestamp)))) AS last_ns
         FROM metric_points
         WHERE ${hostRows(params, range, inRange(params, range))}
           AND ${hostName} = ${params.add(host, "String")}`,
        params,
        DASHBOARD_SETTINGS,
      ),
      cpu(),
      memory(),
      filesystem(),
      rates("network", HOST_METRICS.networkIo, NETWORK_DIRECTION_KEYS),
      rates("disk", HOST_METRICS.diskIo, DISK_DIRECTION_KEYS),
      load(),
    ]);
  const lastNs = seen[0]?.last_ns ?? null;
  const lastSeen = lastNs === null ? null : dateOfNs(lastNs);
  return {
    host,
    lastSeen,
    stale: staleness(range, lastSeen, now),
    start: new Date(buckets.firstMs),
    stepSeconds: buckets.stepMs / 1000,
    buckets: count,
    charts: [...cpuCharts, ...memoryCharts, filesystemChart, network, disk, loadChart],
  };
}
