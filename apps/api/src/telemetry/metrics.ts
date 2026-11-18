import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  DASHBOARD_SETTINGS,
  dateOfNs,
  hasAnyRow,
  labelsInRange,
  type TelemetryRange,
} from "./dashboard-query.ts";

/**
 * The dashboard's metrics (docs/telemetry.md, "The dashboard"): the
 * metrics a project sent in a period, and one metric as a chart over the
 * period, in time buckets, optionally split by one attribute.
 *
 * A series is one combination of a metric's service, scope, attributes,
 * resource attributes, and temporality (a histogram's also its bounds):
 * the `series` column, a hash worked out when the row is written
 * (clickhouse/migrations.ts). Rates and histogram steps are worked out per
 * series in ClickHouse, with window functions over the series ordered by
 * time, then added up per bucket and per value of the split attribute.
 * The metric tables are ordered by project, then name, then time, so a
 * chart reads only its metric's rows.
 */

/**
 * What a metric is, as the dashboard names it: a gauge, a monotonic sum
 * (a counter), a sum that goes up and down (an up-down counter), or a
 * histogram with explicit buckets.
 */
export const METRIC_KINDS = ["gauge", "counter", "updown", "histogram"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/** Metrics the list holds; past this, it says it was cut. */
export const MAX_METRICS = 1000;
/** Series a chart reads, those with the most points; past this, it says it was cut. */
export const MAX_SERIES = 1000;
/**
 * Lines a split chart draws: with more values than this, the values with
 * the least volume fold into one "other" line, so there are at most this
 * many lines with it (the design system's eight chart colors).
 */
export const SPLIT_LINES = 8;
/** Time buckets a chart has at most. */
export const MAX_BUCKETS = 300;
/** Bucket lengths, in seconds: the shortest that keeps a chart within MAX_BUCKETS. */
const STEPS_SECONDS = [
  60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 172_800, 604_800,
];
/**
 * How far before the range a chart reads, at least, so the first point of
 * a cumulative series in the range has the point before it.
 */
const MIN_LOOKBACK_MS = 3_600_000;
/** Services a metric of the list names; serviceCount says how many there are. */
const LIST_SERVICES = 10;
/** Attribute keys a chart offers to split by. */
const MAX_SPLIT_KEYS = 100;

const NANOS_PER_MS = 1_000_000n;

/** Milliseconds since 1970 as nanoseconds, as text for an Int64 parameter. */
const ns = (ms: number) => (BigInt(ms) * NANOS_PER_MS).toString();

/** Each kind's rows: its table, and the condition that picks them. */
const KIND_ROWS: Record<MetricKind, { table: string; condition: string }> = {
  gauge: { table: "metric_points", condition: "kind = 'gauge'" },
  counter: { table: "metric_points", condition: "kind = 'sum' AND monotonic" },
  updown: { table: "metric_points", condition: "kind = 'sum' AND NOT monotonic" },
  histogram: { table: "metric_histograms", condition: "1" },
};

export interface MetricSummary {
  name: string;
  kind: MetricKind;
  /** The unit its latest point named, such as "ms" or "By"; "" when none. */
  unit: string;
  /** Up to LIST_SERVICES of the services sending it, by name. */
  services: string[];
  serviceCount: number;
  lastSeen: Date;
}

/**
 * The metrics with points in the range and environment, by name, each
 * with its kind, unit, services, and when it was last seen. Read without
 * FINAL: a retried copy does not change any of these.
 */
export async function listMetrics(
  reader: Reader,
  range: TelemetryRange,
): Promise<{
  metrics: MetricSummary[];
  /** More than MAX_METRICS metrics: the list holds the first by name. */
  truncated: boolean;
  environments: string[];
  /** Whether the project has sent any metric at all: false shows how to send them. */
  received: boolean;
}> {
  const params = new QueryParams();
  const where = `project_id = ${params.add(range.projectId, "UUID")}
       AND timestamp >= ${params.time(range.from)} AND timestamp < ${params.time(range.to)}
       AND environment = ${params.add(range.environment, "String")}`;
  const [rows, labels] = await Promise.all([
    queryRows<{
      name: string;
      kind: MetricKind;
      unit: string;
      services: string[];
      service_count: string;
      last_ns: string;
    }>(
      reader,
      `SELECT name, kind, argMax(unit, timestamp) AS unit,
              arraySort(groupUniqArray(${LIST_SERVICES})(service)) AS services,
              uniqExact(service) AS service_count,
              toString(toUnixTimestamp64Nano(max(timestamp))) AS last_ns
       FROM (
         SELECT name, multiIf(kind = 'gauge', 'gauge', monotonic, 'counter', 'updown') AS kind,
                unit, service, timestamp
         FROM metric_points WHERE ${where}
         UNION ALL
         SELECT name, 'histogram' AS kind, unit, service, timestamp
         FROM metric_histograms WHERE ${where}
       )
       GROUP BY name, kind
       ORDER BY name, kind
       LIMIT ${MAX_METRICS + 1}`,
      params,
      DASHBOARD_SETTINGS,
    ),
    labelsInRange(reader, ["metric_points", "metric_histograms"], range),
  ]);
  const metrics = rows.slice(0, MAX_METRICS).map((row) => ({
    name: row.name,
    kind: row.kind,
    unit: row.unit,
    services: row.services,
    serviceCount: Number(row.service_count),
    lastSeen: dateOfNs(row.last_ns),
  }));
  return {
    metrics,
    truncated: rows.length > MAX_METRICS,
    environments: labels.environments,
    received:
      metrics.length > 0 ||
      (await hasAnyRow(reader, ["metric_points", "metric_histograms"], range.projectId)),
  };
}

/** A chart's time buckets: `count` of `stepMs` each, from `firstMs`, the last cut at `endMs`. */
export interface Buckets {
  firstMs: number;
  stepMs: number;
  count: number;
  /** The range's start (after the retention's cut): the first bucket's seconds count from here. */
  fromMs: number;
  /** The range's end, or now when sooner: no bucket reaches past it. */
  endMs: number;
}

/**
 * The buckets of a range: the shortest step that keeps them within
 * MAX_BUCKETS, counted from the start of the range's first day so they
 * fall on whole minutes and hours of the instance's time, from the
 * range's start (or the retention's) to its end or now, whichever is sooner.
 */
export function bucketsOf(
  range: Pick<TelemetryRange, "dayStart" | "from" | "to">,
  now: Date,
): Buckets {
  const anchor = range.dayStart.getTime();
  const fromMs = range.from.getTime();
  const endMs = Math.max(fromMs, Math.min(range.to.getTime(), now.getTime()));
  for (const step of STEPS_SECONDS) {
    const stepMs = step * 1000;
    const firstMs = anchor + Math.floor((fromMs - anchor) / stepMs) * stepMs;
    const count = endMs > fromMs ? Math.ceil((endMs - firstMs) / stepMs) : 0;
    if (count <= MAX_BUCKETS || step === STEPS_SECONDS.at(-1)) {
      return { firstMs, stepMs, count: Math.min(count, MAX_BUCKETS), fromMs, endMs };
    }
  }
  throw new Error("unreachable: the last step always returns");
}

/** The seconds of a bucket within the range: the first and last may be cut short. */
export function bucketSeconds(buckets: Buckets, index: number): number {
  const start = Math.max(buckets.fromMs, buckets.firstMs + index * buckets.stepMs);
  const end = Math.min(buckets.endMs, buckets.firstMs + (index + 1) * buckets.stepMs);
  return Math.max(0, end - start) / 1000;
}

/**
 * The value at quantile `q` (0 to 1) of a histogram's buckets: the bucket
 * the rank `q × total` falls in, and a straight line across it between its
 * lower and upper bound. Bucket i holds values in (bounds[i-1], bounds[i]];
 * the first starts at the minimum when known (else 0, or its bound when
 * that is not above 0), the last, which has no upper bound, ends at the
 * maximum when known, else at its lower bound. null without any count.
 */
export function quantileOfBuckets(
  bounds: readonly number[],
  counts: readonly number[],
  q: number,
  min: number | null,
  max: number | null,
): number | null {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return null;
  const rank = q * total;
  let before = 0;
  for (const [index, count] of counts.entries()) {
    if (count > 0 && before + count >= rank) {
      const first = bounds[0];
      let lower: number | null;
      if (index > 0) lower = bounds[index - 1] ?? null;
      else if (first === undefined) lower = min;
      else if (min !== null && min <= first) lower = min;
      else lower = first > 0 ? 0 : first;
      let upper: number | null;
      if (index < bounds.length) upper = bounds[index] ?? null;
      else upper = max !== null && lower !== null && max > lower ? max : lower;
      if (lower === null || upper === null) return lower ?? upper;
      return lower + ((upper - lower) * (rank - before)) / count;
    }
    before += count;
  }
  return null;
}

export interface ChartOptions {
  name: string;
  kind: MetricKind;
  /** An attribute key: one line per value of it. */
  split?: string | undefined;
  /**
   * Instead of `split`, several keys that name one thing (the Collector's
   * `state` and the semantic conventions' `cpu.mode`): each point's line is
   * the value of the first of them it has. The chart's `split` is the first.
   */
  splitAny?: readonly string[] | undefined;
  /** Only the series whose resource has this attribute value, such as one host's (hosts.ts). */
  resource?: { key: string; value: string } | undefined;
  /**
   * Only the points whose first present key of `keys` has this value, such
   * as a state of "used"; with `orMissing`, also the points with none of them.
   */
  attribute?: { keys: readonly string[]; value: string; orMissing?: boolean } | undefined;
  /** Leaves out the points whose first present key of `keys` has this value, such as a mode of "ro". */
  exclude?: { keys: readonly string[]; value: string } | undefined;
  /** Only the series of an instrumentation scope whose name starts with one of these. */
  scopePrefixes?: readonly string[] | undefined;
  /**
   * Gauges only: several metrics in one chart, one line per metric's name
   * (in place of `name` and a split), such as the three load averages.
   */
  names?: readonly string[] | undefined;
  /**
   * One query instead of two: the series are ranked inside the chart's
   * query, so `keys` and `unit` stay empty. For pages that read many small
   * charts, such as a host's (hosts.ts). Not for histograms.
   */
  single?: boolean | undefined;
}

/**
 * The value of the first of `keys` a point's attributes have, else NULL.
 * The keys go in as query parameters.
 */
export function firstAttribute(params: QueryParams, keys: readonly string[]): string {
  if (keys.length === 0) return "CAST(NULL AS Nullable(String))";
  const branches = keys.map((key) => {
    const placeholder = params.add(key, "String");
    return `mapContains(attributes, ${placeholder}), attributes[${placeholder}]`;
  });
  return `multiIf(${branches.join(", ")}, NULL)`;
}

/** One line's values per bucket; null where the bucket has no point. */
export interface ChartSeries {
  /** The split attribute's value; null without a split, or for points without the attribute. */
  value: string | null;
  /** The values with the least volume, folded into one line. */
  other: boolean;
  /** What ranks the lines: points (gauges, up-down counters), the increase (counters), observations (histograms). */
  volume: number;
  /**
   * Per kind: gauge avg, min, max; updown sum (of each series' last
   * value); counter rate (per second); histogram p50, p95, p99, and rate
   * (observations per second).
   */
  values: Record<string, (number | null)[]>;
}

export interface MetricChart {
  name: string;
  kind: MetricKind;
  unit: string;
  /** The first bucket's start. */
  start: Date;
  stepSeconds: number;
  buckets: number;
  split: string | null;
  /** The attribute keys the metric's series have, to split by. */
  keys: string[];
  series: ChartSeries[];
  /** Series read: at most MAX_SERIES. */
  seriesCount: number;
  /** More series than MAX_SERIES: those with the fewest points were left out. */
  seriesCapped: boolean;
  /** A histogram's series left out of the percentiles: other bounds than the most common, or no bucket counts. */
  skippedSeries: number;
  /** A histogram's bounds, as the percentiles read them. */
  bounds: number[];
  /** Whether a histogram's series have bucket counts to work percentiles out from. */
  percentiles: boolean;
}

interface SeriesRow {
  series_key: string;
  points: string;
  series_unit: string;
  keys: string[];
  series_bounds?: number[];
  /** UInt64, as text: the most bucket counts a point of the series has. */
  series_buckets?: string;
}

/** What each kind's lines hold. */
const MEASURES: Record<MetricKind, string[]> = {
  gauge: ["avg", "min", "max"],
  updown: ["sum"],
  counter: ["rate"],
  histogram: ["p50", "p95", "p99", "rate"],
};

/**
 * One metric over the range, in buckets (bucketsOf), as ChartSeries:
 *
 * - gauge: the average, minimum, and maximum of the points in each bucket;
 * - up-down counter: the sum of each series' last value in each bucket;
 * - counter (a monotonic sum): its rate per second. A cumulative series'
 *   increase is the change from its previous point; a value below the
 *   previous one is a reset, and the new value is the increase; a start
 *   time after the previous point starts the series again (each start time
 *   is its own run of points, so two writers sharing a series apart from
 *   their start do not mix), and the value counts since that start, when
 *   known. Each increase is spread over the buckets its interval covers,
 *   in proportion to the overlap. A delta value counts in its point's
 *   bucket. A bucket's rate is its increases over its seconds;
 * - histogram: the 50th, 95th, and 99th percentiles of the observations
 *   in each bucket (quantileOfBuckets), from each series' bucket counts
 *   (a cumulative point's difference from the previous one, as for
 *   counters; a delta point's as they are), in the point's bucket; and the
 *   observations per second, from the counts, as a counter's rate.
 *
 * Reads FINAL, so a retried point counts once; at most MAX_SERIES series,
 * those with the most points.
 */
export async function metricChart(
  reader: Reader,
  range: TelemetryRange,
  options: ChartOptions,
  now: Date,
): Promise<MetricChart> {
  const buckets = bucketsOf(range, now);
  return chartIn(reader, range, options, buckets, {
    untilMs: buckets.endMs,
    lookbackMs: Math.max(buckets.stepMs, MIN_LOOKBACK_MS),
  });
}

/** Whose points a chart reads: a project's, in one environment, its series ranked from `from`. */
interface ChartScope {
  projectId: string;
  environment: string;
  from: Date;
}

/**
 * The rows of a metric that a chart reads, from `from` to before `until`:
 * the sorting key's prefix (project, name, time), then the chart's filters.
 */
export function metricFilter(
  params: QueryParams,
  scope: { projectId: string; environment: string },
  options: Pick<
    ChartOptions,
    "name" | "kind" | "names" | "resource" | "attribute" | "exclude" | "scopePrefixes"
  >,
  from: Date,
  until: Date,
): string {
  const { condition } = KIND_ROWS[options.kind];
  const { resource, attribute, exclude, scopePrefixes, names } = options;
  return `project_id = ${params.add(scope.projectId, "UUID")}
     AND ${
       names === undefined
         ? `name = ${params.add(options.name, "String")}`
         : `name IN ${params.add(names, "Array(String)")}`
     }
     AND timestamp >= ${params.time(from)} AND timestamp < ${params.time(until)}
     AND environment = ${params.add(scope.environment, "String")}
     AND ${condition}
     ${
       resource === undefined
         ? ""
         : `AND resource_attributes[${params.add(resource.key, "String")}] = ${params.add(resource.value, "String")}`
     }
     ${(() => {
       if (attribute === undefined) return "";
       const value = params.add(attribute.value, "String");
       const found = firstAttribute(params, attribute.keys);
       return attribute.orMissing === true
         ? `AND ifNull(${found}, ${value}) = ${value}`
         : `AND ${found} = ${value}`;
     })()}
     ${
       exclude === undefined
         ? ""
         : `AND ifNull(${firstAttribute(params, exclude.keys)}, '') != ${params.add(exclude.value, "String")}`
     }
     ${
       scopePrefixes === undefined
         ? ""
         : `AND (${scopePrefixes
             .map((prefix) => `startsWith(scope_name, ${params.add(prefix, "String")})`)
             .join(" OR ")})`
     }`;
}

/**
 * A chart over `buckets`, reading points before `untilMs` (which may be
 * past the last bucket, so a counter's step that ends after it still
 * counts its part inside), and from `lookbackMs` before the first bucket,
 * so the first point of a cumulative series has the one before it.
 */
async function chartIn(
  reader: Reader,
  range: ChartScope,
  options: ChartOptions,
  buckets: Buckets,
  {
    untilMs,
    lookbackMs,
    freshMs,
  }: {
    untilMs: number;
    lookbackMs: number;
    /**
     * Up-down counters: a series counts in a bucket's total only when its
     * last point there is within this much of the bucket's end, so series
     * that stopped (pods replaced in a deploy) do not add to those that
     * took over.
     */
    freshMs?: number | undefined;
  },
): Promise<MetricChart> {
  const { table } = KIND_ROWS[options.kind];
  const histogram = options.kind === "histogram";

  const splitKeys = options.splitAny ?? (options.split === undefined ? [] : [options.split]);
  const { names } = options;
  const single = options.single === true;
  if (single && histogram) throw new Error("a single-query chart takes no histogram");
  const empty: MetricChart = {
    name: options.name,
    kind: options.kind,
    unit: "",
    start: new Date(buckets.firstMs),
    stepSeconds: buckets.stepMs / 1000,
    buckets: buckets.count,
    split: splitKeys[0] ?? null,
    keys: [],
    series: [],
    seriesCount: 0,
    seriesCapped: false,
    skippedSeries: 0,
    bounds: [],
    percentiles: false,
  };
  if (buckets.count === 0) return empty;

  /** The metric's rows, from `from`, before `untilMs`. */
  const metricRows = (params: QueryParams, from: Date) =>
    metricFilter(params, range, options, from, new Date(untilMs));

  // The series with the most points in the range. No FINAL: copies only weigh the ranking.
  // A single-query chart ranks them inside its own query instead (below).
  const selectParams = new QueryParams();
  const found = single
    ? []
    : await queryRows<SeriesRow>(
        reader,
        `SELECT toString(series) AS series_key, count() AS points, any(unit) AS series_unit,
            any(mapKeys(attributes)) AS keys
            ${histogram ? ", any(bounds) AS series_bounds, max(length(bucket_counts)) AS series_buckets" : ""}
     FROM ${table}
     WHERE ${metricRows(selectParams, range.from)}
     GROUP BY series
     ORDER BY points DESC, series_key
     LIMIT ${MAX_SERIES + 1}`,
        selectParams,
        DASHBOARD_SETTINGS,
      );
  const listed = found.slice(0, MAX_SERIES);
  const keys = [...new Set(listed.flatMap((row) => row.keys))]
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, MAX_SPLIT_KEYS);
  // Percentiles need one set of bounds: the one with the most points among
  // series with bucket counts. Every series counts in the rate.
  let withBuckets: SeriesRow[] = [];
  let bounds: number[] = [];
  if (histogram) {
    const pointsByBounds = new Map<string, { bounds: number[]; points: number }>();
    for (const row of listed) {
      const rowBounds = row.series_bounds ?? [];
      if (Number(row.series_buckets) !== rowBounds.length + 1) continue;
      const key = JSON.stringify(rowBounds);
      const known = pointsByBounds.get(key) ?? { bounds: rowBounds, points: 0 };
      pointsByBounds.set(key, { bounds: rowBounds, points: known.points + Number(row.points) });
    }
    const best = [...pointsByBounds].toSorted((a, b) => b[1].points - a[1].points)[0];
    bounds = best?.[1].bounds ?? [];
    withBuckets = listed.filter(
      (row) =>
        best !== undefined &&
        JSON.stringify(row.series_bounds ?? []) === best[0] &&
        Number(row.series_buckets) === bounds.length + 1,
    );
  }
  const chart: MetricChart = {
    ...empty,
    unit: listed[0]?.series_unit ?? "",
    keys,
    seriesCount: listed.length,
    seriesCapped: found.length > MAX_SERIES,
    skippedSeries: histogram ? listed.length - withBuckets.length : 0,
    bounds,
    percentiles: withBuckets.length > 0,
  };
  if (!single && listed.length === 0) return chart;

  const params = new QueryParams();
  const lookFrom = new Date(buckets.fromMs - lookbackMs);
  const label =
    names === undefined ? firstAttribute(params, splitKeys) : "toNullable(toString(name))";
  const fromNs = params.add(ns(buckets.fromMs), "Int64");
  const lookNs = params.add(ns(lookFrom.getTime()), "Int64");
  const firstNs = params.add(ns(buckets.firstMs), "Int64");
  const stepNs = params.add(ns(buckets.stepMs), "Int64");
  /** The bucket a moment in nanoseconds falls in. */
  const bucketOf = (moment: string) => `intDiv(${moment} - ${firstNs}, ${stepNs})`;
  const percentileSeries = params.add(
    withBuckets.map((row) => row.series_key),
    "Array(String)",
  );
  const seriesListed = single
    ? `series IN (SELECT series FROM ${table} WHERE ${metricRows(params, range.from)}
                  GROUP BY series ORDER BY count() DESC, series LIMIT ${MAX_SERIES})`
    : `toString(series) IN ${params.add(
        listed.map((row) => row.series_key),
        "Array(String)",
      )}`;
  /** The series' points, deduplicated, from the lookback on, with `columns`. */
  const rowsWith = (columns: string, only = seriesListed) =>
    `SELECT series, ${label} AS label, temporality = 'delta' AS is_delta,
            toUnixTimestamp64Nano(timestamp) AS t_ns,
            toUnixTimestamp64Nano(start_timestamp) AS start_ns,
            ${columns}
     FROM ${table} FINAL
     WHERE ${metricRows(params, lookFrom)} AND ${only}`;
  const rows = rowsWith(histogram ? "toInt64(count) AS n" : "value");
  // Per series and start time, by time: the point before (none: 0), whether
  // this point starts the run with a start known within what was read (the
  // value counts from it), and whether it has nothing before it to count
  // from. Then each step's interval: from the point before, or the start,
  // to this point; a delta point's is the point itself.
  const steps = (lagged: string, increase: string, source = rows) => `
    SELECT *, ${bucketOf("greatest(s_ns, " + fromNs + ")")} AS first_bucket, ${bucketOf("t_ns")} AS last_bucket
    FROM (
      SELECT *,
             start_ns > prev_ns AND start_ns >= ${lookNs} AS restarted,
             NOT is_delta AND prev_ns = 0 AND NOT restarted AS unknown,
             multiIf(is_delta, t_ns, restarted, start_ns, prev_ns) AS s_ns,
             ${increase} AS inc
      FROM (
        SELECT *, lagInFrame(t_ns) OVER w AS prev_ns, ${lagged}
        FROM (${source})
        WINDOW w AS (PARTITION BY series, start_ns ORDER BY t_ns
                     ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
      )
    )
    WHERE t_ns >= ${fromNs} AND NOT unknown AND (is_delta OR t_ns > s_ns)`;
  /**
   * Each step's increase over the buckets its interval covers, in
   * proportion to the overlap (at most the chart's buckets: the interval
   * is cut at the range's start); a delta point's all in its bucket.
   */
  const spread = `
    arrayJoin(range(first_bucket, last_bucket + 1)) AS bucket,
    inc * if(t_ns = s_ns, 1,
             (least(t_ns, ${firstNs} + (bucket + 1) * ${stepNs})
              - greatest(s_ns, ${fromNs}, ${firstNs} + bucket * ${stepNs})) / (t_ns - s_ns)) AS part`;

  let perValue: string;
  let fold: string;
  if (options.kind === "gauge") {
    perValue = `
      SELECT label, ${bucketOf("t_ns")} AS bucket, sum(value) AS total_value, count() AS points,
             min(value) AS low, max(value) AS high, count() AS vol
      FROM (${rows}) WHERE t_ns >= ${fromNs}
      GROUP BY label, bucket`;
    fold =
      "sum(total_value) AS total_value, sum(points) AS points, min(low) AS low, max(high) AS high";
  } else if (options.kind === "updown") {
    // Each series' last value in the bucket, added up; with freshMs, only
    // the series whose last point is that close to the bucket's end.
    const fresh =
      freshMs === undefined
        ? ""
        : `HAVING last_ns >= least(${firstNs} + (bucket + 1) * ${stepNs}, ${params.add(ns(buckets.endMs), "Int64")})
                   - ${params.add(ns(freshMs), "Int64")}`;
    perValue = `
      SELECT label, bucket, sum(last_value) AS total, sum(points) AS vol
      FROM (
        SELECT label, ${bucketOf("t_ns")} AS bucket, argMax(value, t_ns) AS last_value,
               count() AS points, max(t_ns) AS last_ns
        FROM (${rows}) WHERE t_ns >= ${fromNs}
        GROUP BY series, label, bucket
        ${fresh}
      )
      GROUP BY label, bucket`;
    fold = "sum(total) AS total";
  } else if (options.kind === "counter") {
    perValue = `
      SELECT label, bucket, sum(part) AS increase, sum(part) AS vol
      FROM (
        SELECT label, ${spread}
        FROM (${steps(
          "lagInFrame(value) OVER w AS prev_value",
          "if(is_delta OR restarted OR value < prev_value, value, value - prev_value)",
        )})
      )
      GROUP BY label, bucket`;
    fold = "sum(increase) AS increase";
  } else {
    // Two parts, added up per value and bucket. The observations per second:
    // the count, per point, spread as a counter's increase. The percentiles:
    // each series' bucket counts per bucket, from its last point in the
    // bucket (a cumulative series) or all its points (delta), so the window
    // that takes differences sorts one row per series and bucket, not one
    // per point with its array: its memory no longer grows with the points.
    // A reset inside a bucket counts only the counts since it.
    const previous = "arrayResize(prev_counts, length(last_counts))";
    const pointBucket = `if(t_ns < ${fromNs}, -1, ${bucketOf("t_ns")})`;
    const counts = rowsWith(
      "CAST(bucket_counts AS Array(Int64)) AS counts, min AS low_value, max AS high_value",
      `toString(series) IN ${percentileSeries}`,
    );
    perValue = `
      SELECT label, bucket, sumForEach(step_counts) AS step_counts, sum(part) AS increase,
             sum(part) AS vol, min(low) AS low, max(high) AS high
      FROM (
        SELECT label, toInt64(bucket) AS bucket, part,
               CAST([], 'Array(Int64)') AS step_counts,
               CAST(NULL, 'Nullable(Float64)') AS low, CAST(NULL, 'Nullable(Float64)') AS high
        FROM (
          SELECT label, ${spread}
          FROM (${steps(
            "lagInFrame(n) OVER w AS prev_n",
            "if(is_delta OR restarted OR n < prev_n, n, n - prev_n)",
          )})
        )
        UNION ALL
        SELECT label, toInt64(bucket) AS bucket, toFloat64(0) AS part,
               if(delta OR restarted
                    OR arrayExists((a, b) -> a < b, last_counts, ${previous}),
                  last_counts, arrayMap((a, b) -> a - b, last_counts, ${previous})) AS step_counts,
               low, high
        FROM (
          SELECT *,
                 first_row AND start_ns >= ${lookNs} AS restarted,
                 NOT delta AND first_row AND NOT restarted AS unknown
          FROM (
            SELECT *, row_number() OVER w = 1 AS first_row,
                   lagInFrame(last_counts) OVER w AS prev_counts
            FROM (
              SELECT series, start_ns, label, ${pointBucket} AS bucket, any(is_delta) AS delta,
                     if(delta, sumForEach(counts), argMax(counts, t_ns)) AS last_counts,
                     min(low_value) AS low, max(high_value) AS high
              FROM (${counts})
              GROUP BY series, start_ns, label, bucket
            )
            WINDOW w AS (PARTITION BY series, start_ns ORDER BY bucket
                         ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
          )
        )
        WHERE bucket >= 0 AND NOT unknown
      )
      GROUP BY label, bucket`;
    fold =
      "sumForEach(step_counts) AS step_counts, sum(increase) AS increase, min(low) AS low, max(high) AS high";
  }

  // Values ranked by their whole volume; past SPLIT_LINES, all from the
  // SPLIT_LINES-th on fold into "other". Ties break by the value, so each
  // has its own rank.
  const slots = params.add(SPLIT_LINES, "UInt32");
  const folded = await queryRows<FoldedRow>(
    reader,
    `SELECT ranks > ${slots} AND rank >= ${slots} AS other, if(other, NULL, label) AS value,
            bucket, ${fold}, sum(vol) AS volume
            ${
              single
                ? `, (SELECT uniqExact(series) FROM ${table}
                      WHERE ${metricRows(params, range.from)}) AS found_series`
                : ""
            }
     FROM (
       SELECT *, max(rank) OVER () AS ranks
       FROM (
         SELECT *, dense_rank() OVER (ORDER BY label_volume DESC, label) AS rank
         FROM (SELECT *, sum(vol) OVER (PARTITION BY label) AS label_volume FROM (${perValue}))
       )
     )
     WHERE bucket >= 0 AND bucket < ${params.add(buckets.count, "Int64")}
     GROUP BY other, value, bucket
     ORDER BY other, value, bucket
     LIMIT ${(SPLIT_LINES + 1) * MAX_BUCKETS}`,
    params,
    DASHBOARD_SETTINGS,
  );
  const series = seriesOf(folded, options.kind, buckets, bounds);
  if (!single) return { ...chart, series };
  const foundSeries = Number(folded[0]?.found_series ?? 0);
  return {
    ...chart,
    series,
    seriesCount: Math.min(foundSeries, MAX_SERIES),
    seriesCapped: foundSeries > MAX_SERIES,
  };
}

interface FoldedRow {
  /** A single-query chart's series in the range, before the cap (UInt64, as text). */
  found_series?: string;
  other: boolean | number;
  value: string | null;
  bucket: string | number;
  volume: string | number;
  total_value?: number;
  points?: string | number;
  total?: number;
  low?: number | null;
  high?: number | null;
  increase?: number;
  step_counts?: (string | number)[];
}

/** The rows of a chart's query as lines, most volume first, "other" last. */
function seriesOf(
  rows: FoldedRow[],
  kind: MetricKind,
  buckets: Buckets,
  bounds: number[],
): ChartSeries[] {
  const lines = new Map<string, ChartSeries>();
  const blank = () => Array.from({ length: buckets.count }, (): number | null => null);
  for (const row of rows) {
    const other = row.other === true || row.other === 1;
    const key = other ? "other" : JSON.stringify(row.value);
    let line = lines.get(key);
    if (line === undefined) {
      line = {
        value: other ? null : row.value,
        other,
        volume: 0,
        values: Object.fromEntries(MEASURES[kind].map((name) => [name, blank()])),
      };
      lines.set(key, line);
    }
    const index = Number(row.bucket);
    line.volume += Number(row.volume);
    const set = (name: string, value: number | null) => {
      const values = line.values[name];
      if (values !== undefined) values[index] = value;
    };
    if (kind === "gauge") {
      const points = Number(row.points ?? 0);
      set("avg", points > 0 ? (row.total_value ?? 0) / points : null);
      set("min", row.low ?? null);
      set("max", row.high ?? null);
      continue;
    }
    if (kind === "updown") {
      set("sum", row.total ?? null);
      continue;
    }
    const seconds = bucketSeconds(buckets, index);
    set("rate", seconds > 0 ? (row.increase ?? 0) / seconds : null);
    if (kind === "histogram") {
      const counts = (row.step_counts ?? []).map(Number);
      const low = row.low ?? null;
      const high = row.high ?? null;
      set("p50", quantileOfBuckets(bounds, counts, 0.5, low, high));
      set("p95", quantileOfBuckets(bounds, counts, 0.95, low, high));
      set("p99", quantileOfBuckets(bounds, counts, 0.99, low, high));
    }
  }
  return [...lines.values()].toSorted(
    (a, b) => Number(a.other) - Number(b.other) || b.volume - a.volume,
  );
}

/**
 * How far before a window a metric's window reads at least (metricWindow):
 * the window's own length, or this when longer, so the point before the
 * window's first is there for a series exported every minute or every
 * few, as SDKs and the Collector do by default, and for one exported less
 * often than its window is long.
 */
export const WINDOW_LOOKBACK_MS = 5 * 60_000;
/**
 * An up-down counter's series counts in a window's total only when its
 * last point is within this of the window's end: two export intervals of
 * a minute. A series that stopped earlier, as a pod replaced in a rolling
 * deploy, is no longer there.
 */
export const FRESH_SERIES_MS = 2 * 60_000;

/** A metric's value over one window, as its chart reads it, per measure; null without data. */
export interface MetricWindow {
  /** Per kind, as ChartSeries' values: gauge avg, min, max; updown sum; counter rate; histogram p50, p95, p99, rate. */
  values: Record<string, number | null>;
  unit: string;
  /** Series read: at most MAX_SERIES. */
  seriesCount: number;
}

/**
 * One metric over [from, to), as a chart of one bucket covering it reads
 * it (chartIn): a gauge's average, minimum, and maximum over the points;
 * an up-down counter's total of the last value of each series still
 * reporting at the window's end (its last point within FRESH_SERIES_MS of
 * it); a counter's rate per second; a histogram's percentiles from the
 * window's bucket counts. Points are read until `readUntil` (past `to`), so
 * a counter's step that ends after the window counts the part inside it,
 * and from the window's length (at least WINDOW_LOOKBACK_MS) before `from`.
 */
export async function metricWindow(
  reader: Reader,
  scope: { projectId: string; environment: string },
  options: Pick<ChartOptions, "name" | "kind" | "resource" | "attribute">,
  from: Date,
  to: Date,
  readUntil: Date,
): Promise<MetricWindow> {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const chart = await chartIn(
    reader,
    { ...scope, from },
    options,
    { firstMs: fromMs, stepMs: toMs - fromMs, count: 1, fromMs, endMs: toMs },
    {
      untilMs: Math.max(toMs, readUntil.getTime()),
      lookbackMs: Math.max(WINDOW_LOOKBACK_MS, toMs - fromMs),
      freshMs: FRESH_SERIES_MS,
    },
  );
  const [line] = chart.series;
  return {
    values: Object.fromEntries(
      MEASURES[options.kind].map((measure) => [measure, line?.values[measure]?.[0] ?? null]),
    ),
    unit: chart.unit,
    seriesCount: chart.seriesCount,
  };
}

/** Whether any point of the metric, of this kind and with these filters, arrived in [from, to). */
export async function metricSeen(
  reader: Reader,
  scope: { projectId: string; environment: string },
  options: Pick<ChartOptions, "name" | "kind" | "resource" | "attribute">,
  from: Date,
  to: Date,
): Promise<boolean> {
  const params = new QueryParams();
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM ${KIND_ROWS[options.kind].table}
     WHERE ${metricFilter(params, scope, options, from, to)}
     LIMIT 1`,
    params,
    DASHBOARD_SETTINGS,
  );
  return rows.length > 0;
}
