import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import { VITAL_NAMES, type VitalName, vitalValue } from "../collection/vitals.ts";
import { VITALS } from "../visits/visits.ts";

/**
 * One vitals event per page load (collection/vitals.ts;
 * docs/web-analytics.md, "Web Vitals").
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
  deviceType?: DeviceType | undefined;
}

export const DEVICE_TYPES = ["desktop", "mobile", "tablet"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * Google thresholds from web-vitals 6.2.3: good through the first value,
 * poor above the second. Units are milliseconds, except the CLS score.
 */
export const THRESHOLDS: Record<VitalName, readonly [number, number]> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
};

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

export const SPEED_PAGES = 20;

/**
 * Reject impossible values on read as well as ingestion: legacy custom
 * events named vitals may contain unchecked values.
 */
const value = vitalValue;

/**
 * Interpolate as NumPy default and Excel PERCENTILE.INC: 1, 2, 3, 4 seconds
 * give 3.25 seconds. Round milliseconds to integers and CLS to four decimals.
 */
const p75 = (name: VitalName) =>
  `round(quantileExactInclusive(0.75)(${value(name)}), ${name === "cls" ? 4 : 0})`;

const CORE_P75 = (["lcp", "inp", "cls"] as const)
  .map((name) => `${p75(name)} AS ${name}`)
  .join(", ");

const count = (raw: unknown) => Number(raw);
const textOrNull = (raw: unknown) => (typeof raw === "string" ? raw : null);
const numberOrNull = (raw: unknown) =>
  raw === null || raw === undefined || Number.isNaN(Number(raw)) ? null : Number(raw);

/** Count only page loads with at least one measured value. */
const MEASURED = `(${VITAL_NAMES.map((name) => `${value(name)} IS NOT NULL`).join(" OR ")})`;

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
 * Include the selected environment and production even without data,
 * so the page can switch back.
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

function eachDay(firstDay: string, lastDay: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  for (let time = Date.parse(`${firstDay}T00:00:00Z`); time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/** Used by the Speed page and overview; most measured loads first. */
export async function speedByDevice(reader: Reader, range: SpeedRange): Promise<Speed["devices"]> {
  const params = new QueryParams();
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT device_type, count() AS loads, ${CORE_P75}
     FROM events FINAL
     WHERE ${scope(params, range)}
     GROUP BY device_type
     ORDER BY loads DESC, device_type`,
    params,
  );
  return rows.map((device) => ({ deviceType: textOrNull(device.device_type), ...row(device) }));
}

/**
 * Check retained history to distinguish no data in this range from
 * no Web Vitals received in this environment.
 */
export async function hasVitals(
  reader: Reader,
  projectId: string,
  environment: string,
): Promise<boolean> {
  const params = new QueryParams();
  const rows = await queryRows<{ found: number }>(
    reader,
    `SELECT 1 AS found FROM events
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND environment = ${params.add(environment, "String")}
       AND name = '${VITALS}'
     LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

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
    speedByDevice(reader, range),
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
    devices,
    pages: pages.map((page) => ({ path: textOrNull(page.path) ?? "", ...row(page) })),
    days: eachDay(range.firstDay, range.lastDay).map((day) => ({
      day,
      ...(byDay.get(day) ?? { loads: 0, lcp: null, inp: null, cls: null }),
    })),
  };
}
