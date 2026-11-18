import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, isTextOrNull } from "./telemetry-shapes";

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
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams(rangeQuery(range, environment));
      return expectShape(
        await apiRequest(`${projectPath(projectId)}/metrics?${query.toString()}`, { signal }),
        isMetricList,
      );
    },
    placeholderData: keepPreviousData,
  });

/** One metric over the range, split by an attribute when one is given. */
export const metricChartQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  metric: { name: string; kind: MetricKind; split: string | undefined },
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
    ],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeQuery(range, environment),
        name: metric.name,
        kind: metric.kind,
        ...(metric.split === undefined ? {} : { split: metric.split }),
      });
      return expectShape(
        await apiRequest(`${projectPath(projectId)}/metrics/chart?${query.toString()}`, { signal }),
        isMetricChart,
      );
    },
    placeholderData: keepPreviousData,
  });
