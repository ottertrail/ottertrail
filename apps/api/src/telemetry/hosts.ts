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
 * Host metrics must come from RECEIVER_SCOPES; SDKs may send identical metric and host names
 * (docs/telemetry.md, "Hosts"). Charts use metrics.ts, filtered by host.name. Prefer utilization
 * gauges when available; the receiver disables them by default, so fall back to shares calculated
 * from default metrics.
 */

export const HOST_KEY = "host.name";

/**
 * Collector v0.80.0 uses otelcol/hostmetricsreceiver/cpu; other versions use scraper Go package
 * paths such as .../internal/scraper/cpuscraper.
 */
export const RECEIVER_SCOPES = [
  "otelcol/hostmetricsreceiver/",
  "github.com/open-telemetry/opentelemetry-collector-contrib/receiver/hostmetricsreceiver/",
] as const;

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

/** A host needs a host.name resource, receiver scope, and one of these metrics. */
const HOST_METRIC_NAMES: readonly string[] = Object.values(HOST_METRICS);

/** Latest-value reads exclude network, disk, and longer load averages. */
const LIST_METRIC_NAMES: readonly string[] = [
  HOST_METRICS.cpuTime,
  HOST_METRICS.cpuUtilization,
  HOST_METRICS.memoryUsage,
  HOST_METRICS.memoryUtilization,
  HOST_METRICS.filesystemUsage,
  HOST_METRICS.filesystemUtilization,
  HOST_METRICS.load1m,
];

/** First present key wins: receiver names, semantic conventions, then older names. */
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

/** Read-only mounts, such as squashfs, stay full and are excluded. */
const READ_ONLY = "ro";

/** Slab is already included in used or cached memory. */
const MEMORY_PARTS = ["slab_reclaimable", "slab_unreclaimable"];

/** Keeps the first hosts by name; reports truncation. */
export const MAX_HOSTS = 500;
export const STALE_MS = 5 * 60_000;
/**
 * Counters need two points; scraper timing can differ. This window supports up to 7.5 minutes
 * between scrapes.
 */
export const LATEST_WINDOW_MS = 15 * 60_000;

export interface HostSummary {
  host: string;
  lastSeen: Date;
  /** No points within STALE_MS; null for historical periods. */
  stale: boolean | null;
  /** 0 to 100; null without enough data. */
  cpuPercent: number | null;
  memoryPercent: number | null;
  /** Fullest writable filesystem and its mount point. */
  filesystemPercent: number | null;
  filesystemMount: string | null;
  load1m: number | null;
}

function receiverScope(params: QueryParams): string {
  return `(${RECEIVER_SCOPES.map(
    (prefix) => `startsWith(scope_name, ${params.add(prefix, "String")})`,
  ).join(" OR ")})`;
}

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

/** Returns null for historical ranges. */
export function staleness(range: TelemetryRange, lastSeen: Date | null, now: Date): boolean | null {
  if (range.to.getTime() <= now.getTime()) return null;
  return lastSeen === null || now.getTime() - lastSeen.getTime() > STALE_MS;
}

interface LatestRow {
  host: string;
  name: string;
  mount: string;
  /** Share (0 to 1) or load; null without enough data. */
  value: number | null;
}

const percent = (row: LatestRow | undefined) =>
  row === undefined || row.value === null ? null : row.value * 100;

/**
 * CPU uses non-idle utilization, falling back to non-idle time between the last two points of one
 * run without a reset. Memory uses used utilization or used bytes over all states except slab.
 * Filesystems use utilization or used bytes over all states; read-only mounts are excluded. Load
 * uses the latest 1-minute average.
 *
 * Reads each host's last LATEST_WINDOW_MS with FINAL so retries cannot become the previous counter
 * point.
 */
export async function listHosts(
  reader: Reader,
  range: TelemetryRange,
  now: Date,
): Promise<{
  hosts: HostSummary[];
  /** Keeps the first MAX_HOSTS by name. */
  truncated: boolean;
  environments: string[];
  /** False shows setup instructions. */
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
    // Names and scopes are constants.
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
 * Merges overlapping host windows, each from LATEST_WINDOW_MS before its last point through that
 * point's millisecond.
 */
export function latestWindows(
  range: TelemetryRange,
  lastMs: readonly number[],
): { startMs: number; endMs: number }[] {
  const windows = lastMs
    .map((last) => ({
      startMs: Math.max(range.from.getTime(), last - LATEST_WINDOW_MS),
      // Include nanosecond timestamps within the last millisecond.
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
 * Time-key ranges cover each host's last minutes, even if it stopped early. Then filter each row
 * to its own host's window (latestWindows).
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
    // Use two points per series for rates. Keep CPUs separate, but take other metrics' latest
    // series per state so Collector upgrades do not double-count.
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

/** One value per bucket; null without points. */
export interface HostLine {
  /** State, mount, direction, or load metric; null when absent. */
  value: string | null;
  /** Low-volume values fold into "other" within eight lines (metrics.ts, SPLIT_LINES). */
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
  /** Source metrics; empty if none arrived. */
  metrics: string[];
  lines: HostLine[];
  /** A metric exceeded MAX_SERIES (metrics.ts). */
  capped: boolean;
}

export interface HostCharts {
  host: string;
  /** Null without host metrics in the range. */
  lastSeen: Date | null;
  /** Null for historical ranges, as in HostSummary. */
  stale: boolean | null;
  start: Date;
  stepSeconds: number;
  buckets: number;
  charts: HostChart[];
}

type Values = (number | null)[];

const perBucket = (count: number, f: (index: number) => number | null): Values =>
  Array.from({ length: count }, (_, index) => f(index));

/** Returns null if no line has a value. */
function sumAt(lines: readonly ChartSeries[], measure: string, index: number): number | null {
  let total: number | null = null;
  for (const line of lines) {
    const value = line.values[measure]?.[index];
    if (value !== null && value !== undefined) total = (total ?? 0) + value;
  }
  return total;
}

/** Returns percentages; null without a positive whole. */
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

const capped = (...charts: MetricChart[]) => charts.some((chart) => chart.seriesCapped);

const metricsOf = (chart: MetricChart) => (chart.series.length === 0 ? [] : [chart.name]);

const named = (chart: MetricChart, value: string) =>
  chart.series.filter((series) => !series.other && series.value === value);

/**
 * Uses metricChart's single-query mode with the host filter. CPU is 100 minus idle share, from
 * utilization or summed CPU-time rates. Memory excludes slab from totals. Filesystems exclude
 * read-only mounts and prefer utilization to usage shares. Network and disk sum byte rates across
 * interfaces or disks; load averages each bucket. At most 10 chart queries plus one last-seen
 * query.
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
    // Receiver utilization has no states. If states are present, only used is the used share.
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
