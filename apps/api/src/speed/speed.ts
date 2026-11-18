import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import { VITAL_NAMES, type VitalName, vitalValue } from "../collection/vitals.ts";
import { VITALS } from "../visits/visits.ts";

/**
 * Web Vitals reports: how fast page loads felt, from the "vitals" event
 * each page load sends once (collection/vitals.ts; docs/web-analytics.md,
 * "Web Vitals").
 */

/** A range of whole days in the instance's timezone, in one environment. */
export interface SpeedRange {
  projectId: string;
  environment: string;
  timeZone: string;
  /** "YYYY-MM-DD", both included. */
  firstDay: string;
  lastDay: string;
  from: Date;
  to: Date;
  /** Only page loads on this kind of device, when given. */
  deviceType?: DeviceType | undefined;
}

export const DEVICE_TYPES = ["desktop", "mobile", "tablet"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * Good up to the first value, poor above the second: Google's thresholds,
 * as the web-vitals library (6.2.3) exports them, in milliseconds and, for
 * CLS, its score.
 */
export const THRESHOLDS: Record<VitalName, readonly [number, number]> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
};

/** The value most page loads were faster than, and how many were good, needed improvement, or poor. */
export interface MetricSummary {
  /** The 75th percentile, as Google's own field data reports; null without values. */
  p75: number | null;
  /** Page loads with a value for this metric. */
  count: number;
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface SpeedRow {
  /** Page loads with any value. */
  loads: number;
  lcp: number | null;
  inp: number | null;
  cls: number | null;
}

export interface Speed {
  /** Page loads with any value in the range. */
  loads: number;
  metrics: Record<VitalName, MetricSummary>;
  devices: (SpeedRow & { deviceType: string | null })[];
  /** The pages with the most measured loads. */
  pages: (SpeedRow & { path: string })[];
  /** Every day of the range. */
  days: (SpeedRow & { day: string })[];
}

/** Pages a report lists. */
export const SPEED_PAGES = 20;

/**
 * A metric's value in a report, NULL when the page load has none, or an
 * impossible one: the API drops those on arrival, but an event named
 * "vitals" a site sent itself before Web Vitals existed was not checked.
 */
const value = vitalValue;

/**
 * The 75th percentile, interpolated between the two nearest values, as
 * NumPy's default and Excel's PERCENTILE.INC do: four loads of 1, 2, 3,
 * and 4 seconds give 3.25 seconds. Milliseconds whole, CLS to four decimals.
 */
const p75 = (name: VitalName) =>
  `round(quantileExactInclusive(0.75)(${value(name)}), ${name === "cls" ? 4 : 0})`;

/** p75 of LCP, INP, and CLS: the three Core Web Vitals. */
const CORE_P75 = (["lcp", "inp", "cls"] as const)
  .map((name) => `${p75(name)} AS ${name}`)
  .join(", ");

const count = (raw: unknown) => Number(raw);
const textOrNull = (raw: unknown) => (typeof raw === "string" ? raw : null);
const numberOrNull = (raw: unknown) =>
  raw === null || raw === undefined || Number.isNaN(Number(raw)) ? null : Number(raw);

/** True for a "vitals" event with at least one value: a measured page load. */
const MEASURED = `(${VITAL_NAMES.map((name) => `${value(name)} IS NOT NULL`).join(" OR ")})`;

/** The page loads of a range: their "vitals" events with a value. */
function scope(params: QueryParams, range: SpeedRange): string {
  return `project_id = ${params.add(range.projectId, "UUID")}
    AND environment = ${params.add(range.environment, "String")}
    AND occurred_at >= ${params.time(range.from)}
    AND occurred_at < ${params.time(range.to)}
    AND name = '${VITALS}'
    AND ${MEASURED}
    ${range.deviceType === undefined ? "" : `AND device_type = ${params.add(range.deviceType, "String")}`}`;
}

function row(raw: Record<string, unknown>): SpeedRow {
  return {
    loads: count(raw.loads),
    lcp: numberOrNull(raw.lcp),
    inp: numberOrNull(raw.inp),
    cls: numberOrNull(raw.cls),
  };
}

/**
 * The environments with measured page loads in the range, most first, then
 * the one shown and production even without: the page can switch back.
 */
export async function speedEnvironments(reader: Reader, range: SpeedRange): Promise<string[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ environment: string }>(
    reader,
    `SELECT environment FROM events
     WHERE project_id = ${params.add(range.projectId, "UUID")}
       AND occurred_at >= ${params.time(range.from)}
       AND occurred_at < ${params.time(range.to)}
       AND name = '${VITALS}'
       AND ${MEASURED}
     GROUP BY environment
     ORDER BY count() DESC, environment`,
    params,
  );
  const names = rows.map((item) => item.environment);
  for (const name of [range.environment, DEFAULT_ENVIRONMENT]) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Every day from firstDay to lastDay, both included. */
function eachDay(firstDay: string, lastDay: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  for (let time = Date.parse(`${firstDay}T00:00:00Z`); time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/** The Speed report of a range: four queries, run side by side. */
export async function speedReport(reader: Reader, range: SpeedRange): Promise<Speed> {
  const summaryParams = new QueryParams();
  const metricColumns = VITAL_NAMES.map((name) => {
    const [good, poor] = THRESHOLDS[name];
    const v = value(name);
    // The names and thresholds are the constants above, never input.
    return `${p75(name)} AS ${name}_p75,
            count(${v}) AS ${name}_count,
            countIf(${v} <= ${good}) AS ${name}_good,
            countIf(${v} > ${good} AND ${v} <= ${poor}) AS ${name}_needs,
            countIf(${v} > ${poor}) AS ${name}_poor`;
  }).join(",\n");
  const deviceParams = new QueryParams();
  const pageParams = new QueryParams();
  const dayParams = new QueryParams();
  const timeZone = dayParams.add(range.timeZone, "String");

  const [[summary], devices, pages, days] = await Promise.all([
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT count() AS loads, ${metricColumns}
       FROM events FINAL
       WHERE ${scope(summaryParams, range)}`,
      summaryParams,
    ),
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT device_type, count() AS loads, ${CORE_P75}
       FROM events FINAL
       WHERE ${scope(deviceParams, range)}
       GROUP BY device_type
       ORDER BY loads DESC, device_type`,
      deviceParams,
    ),
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT path, count() AS loads, ${CORE_P75}
       FROM events FINAL
       WHERE ${scope(pageParams, range)}
       GROUP BY path
       ORDER BY loads DESC, path
       LIMIT ${SPEED_PAGES}`,
      pageParams,
    ),
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT toString(toDate(occurred_at, ${timeZone})) AS day, count() AS loads, ${CORE_P75}
       FROM events FINAL
       WHERE ${scope(dayParams, range)}
       GROUP BY day`,
      dayParams,
    ),
  ]);

  const summarize = (name: VitalName): MetricSummary => ({
    p75: summary === undefined ? null : numberOrNull(summary[`${name}_p75`]),
    count: count(summary?.[`${name}_count`] ?? 0),
    good: count(summary?.[`${name}_good`] ?? 0),
    needsImprovement: count(summary?.[`${name}_needs`] ?? 0),
    poor: count(summary?.[`${name}_poor`] ?? 0),
  });
  const metrics = {
    lcp: summarize("lcp"),
    inp: summarize("inp"),
    cls: summarize("cls"),
    fcp: summarize("fcp"),
    ttfb: summarize("ttfb"),
  };
  const byDay = new Map(days.map((day) => [textOrNull(day.day) ?? "", row(day)]));
  return {
    loads: count(summary?.loads ?? 0),
    metrics,
    devices: devices.map((device) => ({
      deviceType: textOrNull(device.device_type),
      ...row(device),
    })),
    pages: pages.map((page) => ({ path: textOrNull(page.path) ?? "", ...row(page) })),
    days: eachDay(range.firstDay, range.lastDay).map((day) => ({
      day,
      ...(byDay.get(day) ?? { loads: 0, lcp: null, inp: null, cls: null }),
    })),
  };
}
