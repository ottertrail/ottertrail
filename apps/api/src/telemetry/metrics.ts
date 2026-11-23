import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  DASHBOARD_SETTINGS,
  dateOfNs,
  hasAnyRow,
  labelsInRange,
  type TelemetryRange,
} from "./dashboard-query.ts";

/**
 * Series hashes include service, scope, attributes, resource attributes, and temporality;
 * histograms also include bounds (clickhouse/migrations.ts). Compute rates and histogram
 * differences per series before aggregating buckets and split values. Sort keys (project, name,
 * time) limit reads to one metric (docs/telemetry.md, "The dashboard").
 */

/**
 * Counters are monotonic sums; up-down counters are nonmonotonic sums; histograms use explicit
 * buckets.
 */
export const METRIC_KINDS = ["gauge", "counter", "updown", "histogram"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/** Reports truncation past this cap. */
export const MAX_METRICS = 1000;
/** Keeps the series with most points; reports truncation. */
export const MAX_SERIES = 1000;
/**
 * Matches eight design-system chart colors. Low-volume values fold into one "other" line within
 * this cap.
 */
export const SPLIT_LINES = 8;
export const MAX_BUCKETS = 300;
/** Seconds; choose the shortest step within MAX_BUCKETS. */
const STEPS_SECONDS = [
  60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400, 172_800, 604_800,
];
/** Reads a previous point for the first cumulative point in range. */
const MIN_LOOKBACK_MS = 3_600_000;
/** serviceCount includes services omitted by this cap. */
const LIST_SERVICES = 10;
const MAX_SPLIT_KEYS = 100;

const NANOS_PER_MS = 1_000_000n;

/** Nanosecond text for Int64 parameters. */
const ns = (ms: number) => (BigInt(ms) * NANOS_PER_MS).toString();

const KIND_ROWS: Record<MetricKind, { table: string; condition: string }> = {
  gauge: { table: "metric_points", condition: "kind = 'gauge'" },
  counter: { table: "metric_points", condition: "kind = 'sum' AND monotonic" },
  updown: { table: "metric_points", condition: "kind = 'sum' AND NOT monotonic" },
  histogram: { table: "metric_histograms", condition: "1" },
};

export interface MetricSummary {
  name: string;
  kind: MetricKind;
  /** Latest point's unit, e.g. "ms" or "By"; "" if absent. */
  unit: string;
  /** Up to LIST_SERVICES, sorted by name. */
  services: string[];
  serviceCount: number;
  lastSeen: Date;
}

/** Omits FINAL because retries cannot change names, units, services, or last-seen times. */
export async function listMetrics(
  reader: Reader,
  range: TelemetryRange,
): Promise<{
  metrics: MetricSummary[];
  /** Keeps the first MAX_METRICS by name. */
  truncated: boolean;
  environments: string[];
  /** False shows setup instructions. */
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

/** The last bucket is clipped at endMs. */
export interface Buckets {
  firstMs: number;
  stepMs: number;
  count: number;
  /** Clipped range start; first-bucket seconds count from here. */
  fromMs: number;
  /** Range end or now, whichever is earlier. */
  endMs: number;
}

/**
 * Aligns buckets to the first day's start. Multi-day ranges use the full span for a stable step;
 * today uses elapsed time for finer early buckets. Clips to retention and now.
 */
export function bucketsOf(
  range: Pick<TelemetryRange, "dayStart" | "from" | "to" | "firstDay" | "lastDay">,
  now: Date,
  maxBuckets = MAX_BUCKETS,
): Buckets {
  const anchor = range.dayStart.getTime();
  const fromMs = range.from.getTime();
  const endMs = Math.max(fromMs, Math.min(range.to.getTime(), now.getTime()));
  const spanEndMs = range.firstDay === range.lastDay ? endMs : Math.max(fromMs, range.to.getTime());
  for (const step of STEPS_SECONDS) {
    const stepMs = step * 1000;
    const firstMs = anchor + Math.floor((fromMs - anchor) / stepMs) * stepMs;
    const span = spanEndMs > fromMs ? Math.ceil((spanEndMs - firstMs) / stepMs) : 0;
    if (span <= maxBuckets || step === STEPS_SECONDS.at(-1)) {
      const count = endMs > fromMs ? Math.ceil((endMs - firstMs) / stepMs) : 0;
      return { firstMs, stepMs, count: Math.min(count, maxBuckets), fromMs, endMs };
    }
  }
  throw new Error("unreachable: the last step always returns");
}

/** First and last buckets may be partial. */
export function bucketSeconds(buckets: Buckets, index: number): number {
  const start = Math.max(buckets.fromMs, buckets.firstMs + index * buckets.stepMs);
  const end = Math.min(buckets.endMs, buckets.firstMs + (index + 1) * buckets.stepMs);
  return Math.max(0, end - start) / 1000;
}

/**
 * Interpolates rank q × total (q from 0 to 1) within (bounds[i-1], bounds[i]]. The first bucket
 * starts at known min, else 0 or a nonpositive upper bound. The unbounded last bucket ends at
 * known max, else its lower bound. Returns null for zero count.
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
  split?: string | undefined;
  /**
   * First present key supplies the split value, e.g. state or cpu.mode. The chart names the first
   * key as its split.
   */
  splitAny?: readonly string[] | undefined;
  /** Filters resource attributes, e.g. host.name (hosts.ts). */
  resource?: { key: string; value: string } | undefined;
  /** Matches the first present key; orMissing also accepts points without any listed key. */
  attribute?: { keys: readonly string[]; value: string; orMissing?: boolean } | undefined;
  /** Excludes points whose first present key matches, e.g. mode ro. */
  exclude?: { keys: readonly string[]; value: string } | undefined;
  scopePrefixes?: readonly string[] | undefined;
  /** Gauges only: one line per metric name, replacing name and split. */
  names?: readonly string[] | undefined;
  /**
   * Ranks series within one query for small charts (hosts.ts). Leaves keys and unit empty.
   * Excludes histograms.
   */
  single?: boolean | undefined;
  /** Keeps the most populated series; defaults to MAX_SERIES. */
  maxSeries?: number | undefined;
  /** Histograms only: skips observation rates, as needed for sparklines. */
  percentilesOnly?: boolean | undefined;
}

/** First present attribute or NULL. Keys are query parameters. */
export function firstAttribute(params: QueryParams, keys: readonly string[]): string {
  if (keys.length === 0) return "CAST(NULL AS Nullable(String))";
  const branches = keys.map((key) => {
    const placeholder = params.add(key, "String");
    return `mapContains(attributes, ${placeholder}), attributes[${placeholder}]`;
  });
  return `multiIf(${branches.join(", ")}, NULL)`;
}

/** Null buckets have no points. */
export interface ChartSeries {
  /** Null without a split or when the split attribute is absent. */
  value: string | null;
  /** Combines the lowest-volume split values. */
  other: boolean;
  /**
   * Ranks by points for gauges/up-down counters, increase for counters, observations for
   * histograms.
   */
  volume: number;
  /**
   * Gauge: avg/min/max. Updown: last cumulative values or net delta change. Counter: rate/second.
   * Histogram: p50/p95/p99 and observations/second.
   */
  values: Record<string, (number | null)[]>;
}

export interface MetricChart {
  name: string;
  kind: MetricKind;
  unit: string;
  start: Date;
  stepSeconds: number;
  buckets: number;
  split: string | null;
  keys: string[];
  series: ChartSeries[];
  seriesCount: number;
  /** Omits series with the fewest points past MAX_SERIES. */
  seriesCapped: boolean;
  /** Histogram series excluded for missing counts or bounds differing from the most common set. */
  skippedSeries: number;
  bounds: number[];
  /** True if bucket counts permit histogram percentiles. */
  percentiles: boolean;
}

interface SeriesRow {
  series_key: string;
  points: string;
  series_unit: string;
  keys: string[];
  series_bounds?: number[];
  /** Maximum bucket count array length in the series (UInt64 as text). */
  series_buckets?: string;
}

const MEASURES: Record<MetricKind, string[]> = {
  gauge: ["avg", "min", "max"],
  updown: ["sum"],
  counter: ["rate"],
  histogram: ["p50", "p95", "p99", "rate"],
};

/**
 * Reads FINAL to deduplicate points, keeping the MAX_SERIES with most points. Gauges use
 * avg/min/max; up-down counters sum last values.
 *
 * Cumulative counters use differences, treating decreases as resets. Start times separate writer
 * runs. Spread increases across overlapping buckets; delta points count in their own bucket. Rates
 * divide by bucket seconds.
 *
 * Histograms use bucket-count differences for cumulative points and raw counts for delta points.
 * quantileOfBuckets computes p50/p95/p99; observation rates follow counter rules.
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

interface ChartScope {
  projectId: string;
  environment: string;
  from: Date;
}

/** Filters sorting-key prefix (project, name, time) before chart filters. */
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
 * Reads lookbackMs before the first bucket for cumulative differences, and through untilMs so
 * steps ending later still contribute their overlap.
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
     * Exclude cumulative series whose last point is too old, so replaced pods do not add to
     * replacements.
     */
    freshMs?: number | undefined;
  },
): Promise<MetricChart> {
  const { table } = KIND_ROWS[options.kind];
  const histogram = options.kind === "histogram";

  const splitKeys = options.splitAny ?? (options.split === undefined ? [] : [options.split]);
  const { names } = options;
  const single = options.single === true;
  const maxSeries = options.maxSeries ?? MAX_SERIES;
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

  const metricRows = (params: QueryParams, from: Date) =>
    metricFilter(params, range, options, from, new Date(untilMs));

  // Retries affect only ranking, so no FINAL. Single-query charts rank within their query.
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
     LIMIT ${maxSeries + 1}`,
        selectParams,
        DASHBOARD_SETTINGS,
      );
  const listed = found.slice(0, maxSeries);
  const keys = [...new Set(listed.flatMap((row) => row.keys))]
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, MAX_SPLIT_KEYS);
  // Percentiles use the most populated bounds set with counts. Rates include all series.
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
    seriesCapped: found.length > maxSeries,
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
  /** FINAL deduplicates points, including the lookback. */
  const rowsWith = (columns: string, only = seriesListed) =>
    `SELECT series, ${label} AS label, temporality = 'delta' AS is_delta,
            toUnixTimestamp64Nano(timestamp) AS t_ns,
            toUnixTimestamp64Nano(start_timestamp) AS start_ns,
            ${columns}
     FROM ${table} FINAL
     WHERE ${metricRows(params, lookFrom)} AND ${only}`;
  const rows = rowsWith(histogram ? "toInt64(count) AS n" : "value");
  // Separate series by start time. Each step spans the previous point or known run start through
  // this point; delta steps have no duration.
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
   * Spread increases by overlap, clipped to chart buckets. Delta increases stay in their point's
   * bucket.
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
    // Sum last cumulative values and net delta changes. freshMs excludes stale cumulative series.
    const fresh =
      freshMs === undefined
        ? ""
        : `HAVING delta OR last_ns >= least(${firstNs} + (bucket + 1) * ${stepNs}, ${params.add(ns(buckets.endMs), "Int64")})
                   - ${params.add(ns(freshMs), "Int64")}`;
    perValue = `
      SELECT label, bucket, sum(last_value) AS total, sum(points) AS vol
      FROM (
        SELECT label, ${bucketOf("t_ns")} AS bucket, max(is_delta) AS delta,
               if(delta, sum(value), argMax(value, t_ns)) AS last_value,
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
    // Rates spread counts across intervals. Percentiles aggregate arrays per series/bucket before
    // window differences to bound memory. A reset within a bucket keeps only counts since reset.
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
        ${
          options.percentilesOnly === true
            ? ""
            : `SELECT label, toInt64(bucket) AS bucket, part,
               CAST([], 'Array(Int64)') AS step_counts,
               CAST(NULL, 'Nullable(Float64)') AS low, CAST(NULL, 'Nullable(Float64)') AS high
        FROM (
          SELECT label, ${spread}
          FROM (${steps(
            "lagInFrame(n) OVER w AS prev_n",
            "if(is_delta OR restarted OR n < prev_n, n, n - prev_n)",
          )})
        )
        UNION ALL`
        }
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

  // Rank by volume, breaking ties by value. Fold SPLIT_LINES-th and later values into "other".
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
  /** Uncapped series count (UInt64 as text). */
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

/** Most volume first; "other" last. */
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

/** At this cap, a day uses hours and 7 days uses 6-hour buckets. */
export const SPARKLINE_BUCKETS = 30;
/** Limits full-period reads because lists request one sparkline per metric. */
export const SPARKLINE_MAX_DAYS = 7;
/** Sparklines read fewer series than full charts (MAX_SERIES). */
export const SPARKLINE_SERIES = 100;

/** Matches each chart's default measure: gauge average, updown total, counter rate, histogram p95. */
export const SPARKLINE_MEASURES: Record<MetricKind, string> = {
  gauge: "avg",
  updown: "sum",
  counter: "rate",
  histogram: "p95",
};

export interface MetricSparkline {
  name: string;
  kind: MetricKind;
  measure: string;
  start: Date;
  stepSeconds: number;
  buckets: number;
  /** Null without data or histogram bucket counts. */
  values: (number | null)[];
  percentiles: boolean;
  seriesCount: number;
  /** Omits series with the fewest points past SPARKLINE_SERIES. */
  seriesCapped: boolean;
}

/**
 * Ranks series without FINAL, then reads their points with FINAL and lookback. Histogram
 * sparklines read bucket counts only, skipping observation rates.
 */
export async function metricSparkline(
  reader: Reader,
  range: TelemetryRange,
  options: Pick<ChartOptions, "name" | "kind">,
  now: Date,
): Promise<MetricSparkline> {
  const buckets = bucketsOf(range, now, SPARKLINE_BUCKETS);
  const chart = await chartIn(
    reader,
    range,
    {
      name: options.name,
      kind: options.kind,
      maxSeries: SPARKLINE_SERIES,
      percentilesOnly: true,
    },
    buckets,
    { untilMs: buckets.endMs, lookbackMs: Math.max(buckets.stepMs, MIN_LOOKBACK_MS) },
  );
  const measure = SPARKLINE_MEASURES[options.kind];
  const [line] = chart.series;
  return {
    name: options.name,
    kind: options.kind,
    measure,
    start: chart.start,
    stepSeconds: chart.stepSeconds,
    buckets: chart.buckets,
    values: line?.values[measure] ?? Array.from({ length: buckets.count }, () => null),
    percentiles: options.kind !== "histogram" || chart.percentiles,
    seriesCount: chart.seriesCount,
    seriesCapped: chart.seriesCapped,
  };
}

/** Minimum lookback for finding a previous point; longer windows use their own length. */
export const WINDOW_LOOKBACK_MS = 5 * 60_000;
/**
 * Two one-minute export intervals. Excludes stopped series, such as replaced pods, from up-down
 * totals.
 */
export const FRESH_SERIES_MS = 2 * 60_000;

/** Null measures have no data. */
export interface MetricWindow {
  /** Uses the same measures as ChartSeries.values. */
  values: Record<string, number | null>;
  unit: string;
  seriesCount: number;
}

/**
 * Uses one chart bucket for [from, to). Keeps up-down series fresh within FRESH_SERIES_MS. Reads
 * through readUntil for overlapping counter steps, with lookback of at least WINDOW_LOOKBACK_MS.
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
