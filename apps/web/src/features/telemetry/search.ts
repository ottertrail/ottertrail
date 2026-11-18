import { DEFAULT_ENVIRONMENT, DEFAULT_PERIOD, type PageRange } from "@/lib/analytics-api";
import { isSeverity, isTraceId, type LogFilters } from "@/lib/logs-api";
import { isMetricKind, type MetricKind } from "@/lib/metrics-api";
import { MIN_DURATIONS, type TraceFilters } from "@/lib/traces-api";

/** The days in an address: left out for the default period. */
export const rangeSearch = (range: PageRange) =>
  "period" in range
    ? range.period === DEFAULT_PERIOD
      ? {}
      : { period: range.period }
    : { from: range.from, to: range.to };

export const environmentSearch = (environment: string) =>
  environment === DEFAULT_ENVIRONMENT ? {} : { env: environment };

/** Text a filter takes from an address: up to 200 characters, none for empty. */
export function filterText(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" || text.length > 200 ? undefined : text;
}

/** The Traces page's address: what it shows, the defaults left out. */
export interface TracesSearch {
  range: PageRange;
  environment: string;
  filters: TraceFilters;
}

export const tracesSearchOf = ({ range, environment, filters }: TracesSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(filters.service === undefined ? {} : { service: filters.service }),
  ...(filters.name === undefined ? {} : { name: filters.name }),
  ...(filters.errors === true ? { errors: true } : {}),
  ...(filters.minDuration === undefined ? {} : { min: filters.minDuration }),
});

/** The trace filters from an address; anything the page does not offer is dropped. */
export function traceFiltersFrom(search: {
  service?: unknown;
  name?: unknown;
  errors?: unknown;
  min?: unknown;
}): TraceFilters {
  const min = MIN_DURATIONS.find((value) => value === search.min);
  return {
    service: filterText(search.service),
    name: filterText(search.name),
    errors: search.errors === true || search.errors === "true" ? true : undefined,
    minDuration: min,
  };
}

/** The Logs page's address. */
export interface LogsSearch {
  range: PageRange;
  environment: string;
  filters: LogFilters;
}

export const logsSearchOf = ({ range, environment, filters }: LogsSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(filters.service === undefined ? {} : { service: filters.service }),
  ...(filters.severity === undefined ? {} : { severity: filters.severity }),
  ...(filters.search === undefined ? {} : { q: filters.search }),
  ...(filters.traceId === undefined ? {} : { trace: filters.traceId }),
});

export function logFiltersFrom(search: {
  service?: unknown;
  severity?: unknown;
  q?: unknown;
  trace?: unknown;
}): LogFilters {
  return {
    service: filterText(search.service),
    severity: isSeverity(search.severity) ? search.severity : undefined,
    search: filterText(search.q),
    traceId: isTraceId(search.trace) ? search.trace.toLowerCase() : undefined,
  };
}

/** What a metric's chart shows of each line when it is split: one measure. */
export const METRIC_STATS = {
  gauge: ["avg", "min", "max"],
  updown: ["sum"],
  counter: ["rate"],
  histogram: ["p50", "p95", "p99"],
} as const satisfies Record<MetricKind, readonly string[]>;
export type MetricStat = (typeof METRIC_STATS)[MetricKind][number];

/** The measure a split chart shows first: a gauge's average, a histogram's 95th percentile. */
export const DEFAULT_STAT: Record<MetricKind, MetricStat> = {
  gauge: "avg",
  updown: "sum",
  counter: "rate",
  histogram: "p95",
};

/** A metric's page's address, besides its name: its kind, and the split and measure shown. */
export interface MetricSearch {
  range: PageRange;
  environment: string;
  kind: MetricKind;
  split: string | undefined;
  stat: MetricStat;
}

export const metricSearchOf = ({ range, environment, kind, split, stat }: MetricSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  kind,
  ...(split === undefined ? {} : { split }),
  ...(stat === DEFAULT_STAT[kind] ? {} : { stat }),
});

/** The kind, split, and measure from an address; a kind that is not one leaves undefined. */
export function metricChoicesFrom(search: { kind?: unknown; split?: unknown; stat?: unknown }): {
  kind: MetricKind | undefined;
  split: string | undefined;
  stat: MetricStat | undefined;
} {
  const kind = isMetricKind(search.kind) ? search.kind : undefined;
  // A key such as "2024" comes back from the address as a number.
  const key = typeof search.split === "number" ? String(search.split) : search.split;
  const split = typeof key === "string" && key !== "" && key.length <= 256 ? key : undefined;
  const stats: readonly MetricStat[] = kind === undefined ? [] : METRIC_STATS[kind];
  const stat = stats.find((name) => name === search.stat);
  return { kind, split, stat };
}
