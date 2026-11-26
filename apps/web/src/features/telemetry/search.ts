import { type AiFilters, MAX_AI_LABEL } from "@/lib/ai-api";
import { DEFAULT_ENVIRONMENT, DEFAULT_PERIOD, type PageRange } from "@/lib/analytics-api";
import { DEFAULT_DATABASE_SORT, type DatabaseSort } from "@/lib/databases-api";
import { isSeverity, isTraceId, type LogFilters, type LogWindow } from "@/lib/logs-api";
import { isMetricKind, type MetricKind } from "@/lib/metrics-api";
import { MIN_DURATIONS, type TraceFilters } from "@/lib/traces-api";

export const rangeSearch = (range: PageRange) =>
  "period" in range
    ? range.period === DEFAULT_PERIOD
      ? {}
      : { period: range.period }
    : { from: range.from, to: range.to };

export const environmentSearch = (environment: string) =>
  environment === DEFAULT_ENVIRONMENT ? {} : { env: environment };

/** Match the API's 200-character filter limit. */
export function filterText(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" || text.length > 200 ? undefined : text;
}

/** Match the API's 4 KB limit; convert router-parsed numbers back to text. */
export function searchValue(value: unknown, max = 4096): string | undefined {
  const found = typeof value === "number" ? String(value) : value;
  return typeof found === "string" && found !== "" && found.length <= max ? found : undefined;
}

export interface ServicesSearch {
  range: PageRange;
  environment: string;
  service?: string | undefined;
  route?: string | undefined;
}

export const servicesSearchOf = ({ range, environment, service, route }: ServicesSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(service === undefined ? {} : { service }),
  ...(service === undefined || route === undefined ? {} : { route }),
});

export function serviceChoiceFrom(search: { service?: unknown; route?: unknown }): {
  service: string | undefined;
  route: string | undefined;
} {
  const service = searchValue(search.service, 256);
  return { service, route: service === undefined ? undefined : searchValue(search.route) };
}

export interface ServiceSearch {
  range: PageRange;
  environment: string;
  route?: string | undefined;
}

export const serviceSearchOf = ({ range, environment, route }: ServiceSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(route === undefined ? {} : { route }),
});

export interface DatabasesSearch {
  range: PageRange;
  environment: string;
  sort?: DatabaseSort | undefined;
}

export const databasesSearchOf = ({ range, environment, sort }: DatabasesSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(sort === undefined || sort === DEFAULT_DATABASE_SORT ? {} : { sort }),
});

export const shapeSearchOf = ({
  range,
  environment,
}: {
  range: PageRange;
  environment: string;
}) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
});

const MAX_NAME_FILTER = 200;

export const routeTraceFilters = (service: string, route?: string) => ({
  service,
  name:
    route === undefined || !isNamedRoute(route) || route.length > MAX_NAME_FILTER
      ? undefined
      : route.trim(),
});

/** Routes containing only spaces cannot be addressed or used in alert rules. */
export const isNamedRoute = (route: string) => route.trim() !== "";

/** Browsers remove . and .. path segments, making their service pages unreachable. */
export const isLinkableService = (service: string) => service !== "." && service !== "..";

export const addRuleSearch = (environment: string, service: string, route?: string) => ({
  add: "route_latency" as const,
  service,
  ...(route === undefined || !isNamedRoute(route) ? {} : { route }),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
});

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

/** Discard filters the page does not offer. */
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

export interface LogsSearch {
  range: PageRange;
  environment: string;
  filters: LogFilters;
  /** Preserve the period while Live is on so switching back restores it. */
  live?: boolean | undefined;
  /** A time window that replaces the days, as an alert's link opens the page. */
  window?: LogWindow | undefined;
}

export const logsSearchOf = ({ range, environment, filters, live, window }: LogsSearch) => ({
  ...rangeSearch(range),
  ...(window === undefined ? {} : { start: window.start, end: window.end }),
  ...(live === true ? { live: true } : {}),
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

export const METRIC_STATS = {
  gauge: ["avg", "min", "max"],
  updown: ["sum"],
  counter: ["rate"],
  histogram: ["p50", "p95", "p99"],
} as const satisfies Record<MetricKind, readonly string[]>;
export type MetricStat = (typeof METRIC_STATS)[MetricKind][number];

export const DEFAULT_STAT: Record<MetricKind, MetricStat> = {
  gauge: "avg",
  updown: "sum",
  counter: "rate",
  histogram: "p95",
};

export interface MetricSearch {
  range: PageRange;
  environment: string;
  kind: MetricKind;
  split: string | undefined;
  stat: MetricStat;
  host?: string | undefined;
  attr?: { key: string; value: string } | undefined;
}

export const metricSearchOf = ({
  range,
  environment,
  kind,
  split,
  stat,
  host,
  attr,
}: MetricSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  kind,
  ...(split === undefined ? {} : { split }),
  ...(stat === DEFAULT_STAT[kind] ? {} : { stat }),
  ...(host === undefined ? {} : { host }),
  ...(attr === undefined ? {} : { attr: attr.key, attrValue: attr.value }),
});

export function metricFiltersFrom(search: {
  host?: unknown;
  attr?: unknown;
  attrValue?: unknown;
}): { host: string | undefined; attr: { key: string; value: string } | undefined } {
  const key = searchValue(search.attr, 256);
  const value =
    typeof search.attrValue === "string" && search.attrValue.length <= 4096
      ? search.attrValue
      : searchValue(search.attrValue);
  return {
    host: searchValue(search.host),
    attr: key === undefined || value === undefined ? undefined : { key, value },
  };
}

export function metricChoicesFrom(search: { kind?: unknown; split?: unknown; stat?: unknown }): {
  kind: MetricKind | undefined;
  split: string | undefined;
  stat: MetricStat | undefined;
} {
  const kind = isMetricKind(search.kind) ? search.kind : undefined;
  // The router parses numeric attribute names such as 2024 as numbers.
  const key = typeof search.split === "number" ? String(search.split) : search.split;
  const split = typeof key === "string" && key !== "" && key.length <= 256 ? key : undefined;
  const stats: readonly MetricStat[] = kind === undefined ? [] : METRIC_STATS[kind];
  const stat = stats.find((name) => name === search.stat);
  return { kind, split, stat };
}

export interface AiSearch {
  range: PageRange;
  environment: string;
  filters: AiFilters;
}

export const aiSearchOf = ({ range, environment, filters }: AiSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(filters.service === undefined ? {} : { service: filters.service }),
  ...(filters.provider === undefined ? {} : { provider: filters.provider }),
  ...(filters.model === undefined ? {} : { model: filters.model }),
  ...(filters.feature === undefined ? {} : { feature: filters.feature }),
});

/** Preserve stored labels up to 100 characters; convert parsed numbers back to text. */
function aiLabel(value: unknown, { empty = false } = {}): string | undefined {
  const found = typeof value === "number" ? String(value) : value;
  if (typeof found !== "string" || found.length > MAX_AI_LABEL) return undefined;
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  if (/[\u0000-\u001F\u007F]/u.test(found)) return undefined;
  return found === "" && !empty ? undefined : found;
}

/** An empty feature filter selects calls without a feature. */
export function aiFiltersFrom(search: {
  service?: unknown;
  provider?: unknown;
  model?: unknown;
  feature?: unknown;
}): AiFilters {
  return {
    service: searchValue(search.service, 256),
    provider: aiLabel(search.provider),
    model: aiLabel(search.model),
    feature: aiLabel(search.feature, { empty: true }),
  };
}
