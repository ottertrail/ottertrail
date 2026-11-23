import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import {
  isListOf,
  isNumber,
  isRecord,
  isText,
  isTextOrNull,
  telemetryRetry,
} from "./telemetry-shapes";

/** A gauge, a monotonic sum (counter), a sum that goes up and down, or a histogram. */
export const METRIC_KINDS = ["gauge", "counter", "updown", "histogram"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export const isMetricKind = (value: unknown): value is MetricKind =>
  METRIC_KINDS.some((kind) => kind === value);

/** What each kind's lines hold, per bucket (apps/api/src/telemetry/metrics.ts). */
export const MEASURES: Record<MetricKind, readonly string[]> = {
  gauge: ["avg", "min", "max"],
  updown: ["sum"],
  counter: ["rate"],
  histogram: ["p50", "p95", "p99", "rate"],
};

export interface MetricSummary {
  name: string;
  kind: MetricKind;
  unit: string;
  /** Up to 10, by name. */
  services: string[];
  serviceCount: number;
  lastSeen: string;
}

/** GET /api/projects/:id/metrics */
export interface MetricList {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  metrics: MetricSummary[];
  /** More than 1,000 metrics: the first by name. */
  truncated: boolean;
  /** Whether the project has sent any metric at all. */
  received: boolean;
}

/** One line of a chart: a value per bucket of each measure, null where nothing arrived. */
export interface MetricSeries {
  /** The split attribute's value; null without a split, or for points without it. */
  value: string | null;
  /** The values with the least volume, folded together. */
  other: boolean;
  volume: number;
  values: Record<string, (number | null)[]>;
}

/** GET /api/projects/:id/metrics/chart */
export interface MetricChart {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  name: string;
  kind: MetricKind;
  unit: string;
  /** The first bucket's start. */
  start: string;
  stepSeconds: number;
  buckets: number;
  split: string | null;
  /** Attribute keys to split by. */
  keys: string[];
  series: MetricSeries[];
  seriesCount: number;
  seriesCapped: boolean;
  skippedSeries: number;
  bounds: number[];
  /** Whether a histogram's series have bucket counts to work percentiles out from. */
  percentiles: boolean;
}

const isMetricSummary = (value: unknown): value is MetricSummary =>
  isRecord(value) &&
  isText(value.name) &&
  isMetricKind(value.kind) &&
  isText(value.unit) &&
  isListOf(value.services, isText) &&
  isNumber(value.serviceCount) &&
  isText(value.lastSeen);

const isMetricList = (value: unknown): value is MetricList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isListOf(value.metrics, isMetricSummary) &&
  typeof value.truncated === "boolean" &&
  typeof value.received === "boolean";

const isValueOrNull = (value: unknown): value is number | null => value === null || isNumber(value);

/** A line with each of the kind's measures, a value per bucket. */
const isSeriesOf =
  (kind: MetricKind, buckets: number) =>
  (value: unknown): value is MetricSeries => {
    if (!isRecord(value) || !isRecord(value.values)) return false;
    const lines = value.values;
    return (
      isTextOrNull(value.value) &&
      typeof value.other === "boolean" &&
      isNumber(value.volume) &&
      MEASURES[kind].every((name) => {
        const values = lines[name];
        return isListOf(values, isValueOrNull) && values.length === buckets;
      })
    );
  };

const isMetricChart = (value: unknown): value is MetricChart =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isText(value.name) &&
  isMetricKind(value.kind) &&
  isText(value.unit) &&
  isText(value.start) &&
  isNumber(value.stepSeconds) &&
  isNumber(value.buckets) &&
  isTextOrNull(value.split) &&
  isListOf(value.keys, isText) &&
  isListOf(value.series, isSeriesOf(value.kind, value.buckets)) &&
  isNumber(value.seriesCount) &&
  typeof value.seriesCapped === "boolean" &&
  isNumber(value.skippedSeries) &&
  isListOf(value.bounds, isNumber) &&
  typeof value.percentiles === "boolean";

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

const rangeQuery = (range: PageRange, environment: string) => ({
  ...rangeParams(range),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
});

/** The project's metrics in the range, by name. */
export const metricsQuery = (projectId: string, range: PageRange, environment: string) =>
  queryOptions({
    queryKey: ["metrics", projectId, range, environment],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams(rangeQuery(range, environment));
      return expectShape(
        await apiRequest(`${projectPath(projectId)}/metrics?${query.toString()}`, { signal }),
        isMetricList,
      );
    },
    placeholderData: keepPreviousData,
  });

/** What a metric's chart reads only: one host's series, one attribute value's points. */
export interface MetricFilters {
  host?: string | undefined;
  attr?: { key: string; value: string } | undefined;
}

/** One metric over the range, split by an attribute when one is given, within its filters. */
export const metricChartQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  metric: { name: string; kind: MetricKind; split: string | undefined } & MetricFilters,
) =>
  queryOptions({
    queryKey: [
      "metric",
      projectId,
      range,
      environment,
      metric.name,
      metric.kind,
      metric.split ?? null,
      metric.host ?? null,
      metric.attr ?? null,
    ],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeQuery(range, environment),
        name: metric.name,
        kind: metric.kind,
        ...(metric.split === undefined ? {} : { split: metric.split }),
        ...(metric.host === undefined ? {} : { host: metric.host }),
        ...(metric.attr === undefined
          ? {}
          : { attr: metric.attr.key, attrValue: metric.attr.value }),
      });
      return expectShape(
        await apiRequest(`${projectPath(projectId)}/metrics/chart?${query.toString()}`, { signal }),
        isMetricChart,
      );
    },
    placeholderData: keepPreviousData,
  });

/** GET /api/projects/:id/metrics/sparkline: one listed metric's default line, in at most 30 buckets. */
export interface MetricSparkline {
  timeZone: string;
  name: string;
  kind: MetricKind;
  /** avg (gauge), sum (up-down counter), rate (counter), p95 (histogram). */
  measure: string;
  /** The first bucket's start, ISO. */
  start: string;
  stepSeconds: number;
  buckets: number;
  /** null where nothing arrived. */
  values: (number | null)[];
  /** False for a histogram without bucket counts: no percentile to draw. */
  percentiles: boolean;
  /** Series read: at most 100, those with the most points. */
  seriesCount: number;
  /** More series than that: the line leaves out those with the fewest points. */
  seriesCapped: boolean;
}

const isMetricSparkline = (value: unknown): value is MetricSparkline =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.name) &&
  isMetricKind(value.kind) &&
  isText(value.measure) &&
  isText(value.start) &&
  isNumber(value.stepSeconds) &&
  isNumber(value.buckets) &&
  isListOf(value.values, isValueOrNull) &&
  value.values.length === value.buckets &&
  typeof value.percentiles === "boolean" &&
  isNumber(value.seriesCount) &&
  typeof value.seriesCapped === "boolean";

/** Sparkline requests a page has in flight at most; the rest wait their turn. */
export const SPARKLINES_AT_ONCE = 2;
let sparklinesRunning = 0;
const sparklineTurns: (() => void)[] = [];

/** Limit sparkline requests to two at a time. Canceled queries leave the queue without a request. */
async function inSparklineTurn<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (sparklinesRunning >= SPARKLINES_AT_ONCE) {
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        const at = sparklineTurns.indexOf(start);
        if (at !== -1) sparklineTurns.splice(at, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", leave, { once: true });
      sparklineTurns.push(start);
    });
  } else {
    sparklinesRunning += 1;
  }
  try {
    return await work();
  } finally {
    // The turn passes straight to the next waiting line, if one waits.
    const next = sparklineTurns.shift();
    if (next === undefined) sparklinesRunning -= 1;
    else next();
  }
}

/** One metric of the list over the range, as its sparkline draws it. */
export const metricSparklineQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  metric: { name: string; kind: MetricKind },
) =>
  queryOptions({
    queryKey: ["metric", projectId, "sparkline", range, environment, metric.name, metric.kind],
    retry: telemetryRetry,
    queryFn: ({ signal }) =>
      inSparklineTurn(async () => {
        const query = new URLSearchParams({
          ...rangeQuery(range, environment),
          name: metric.name,
          kind: metric.kind,
        });
        return expectShape(
          await apiRequest(`${projectPath(projectId)}/metrics/sparkline?${query.toString()}`, {
            signal,
          }),
          isMetricSparkline,
        );
      }, signal),
    // A row's line is never another period's: a new period shows the skeleton.
    staleTime: 60_000,
  });
