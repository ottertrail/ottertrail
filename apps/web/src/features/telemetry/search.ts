import { DEFAULT_ENVIRONMENT, DEFAULT_PERIOD, type PageRange } from "@/lib/analytics-api";
import { DEFAULT_DATABASE_SORT, type DatabaseSort } from "@/lib/databases-api";
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

/**
 * A value an address names, such as a route, a host, or an attribute's
 * value: up to `max` characters (4 KB, as the API takes them); a number
 * the address parsed comes back as text.
 */
export function searchValue(value: unknown, max = 4096): string | undefined {
  const found = typeof value === "number" ? String(value) : value;
  return typeof found === "string" && found !== "" && found.length <= max ? found : undefined;
}

/** The Services page's address: besides the days and environment, a service and route to show. */
export interface ServicesSearch {
  range: PageRange;
  environment: string;
  /** Only this service's card. */
  service?: string | undefined;
  /** Its route, marked. */
  route?: string | undefined;
}

export const servicesSearchOf = ({ range, environment, service, route }: ServicesSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(service === undefined ? {} : { service }),
  ...(service === undefined || route === undefined ? {} : { route }),
});

/** The service and route an address names. */
export function serviceChoiceFrom(search: { service?: unknown; route?: unknown }): {
  service: string | undefined;
  route: string | undefined;
} {
  const service = searchValue(search.service, 256);
  return { service, route: service === undefined ? undefined : searchValue(search.route) };
}

/** A service's page's address, besides its name: the days, environment, and a route of it. */
export interface ServiceSearch {
  range: PageRange;
  environment: string;
  /** Only this route's requests. */
  route?: string | undefined;
}

export const serviceSearchOf = ({ range, environment, route }: ServiceSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(route === undefined ? {} : { route }),
});

/** The Databases page's address: the days, environment, and what the shapes are sorted by. */
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

/** A query shape's page's address, besides its ID: the days and environment. */
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

/** The longest name the Traces page's filter takes. */
const MAX_NAME_FILTER = 200;

/** The Traces page's filters for a service's requests, or a route's (as part of the name). */
export const routeTraceFilters = (service: string, route?: string) => ({
  service,
  name:
    route === undefined || !isNamedRoute(route) || route.length > MAX_NAME_FILTER
      ? undefined
      : route.trim(),
});

/**
 * Whether a route has a name to address it by: one of only spaces has
 * none, so it gets no page and no alert rule, as an empty one.
 */
export const isNamedRoute = (route: string) => route.trim() !== "";

/**
 * Whether a service's name can be a path segment: a browser drops "." and
 * "..", so their page could not be reached.
 */
export const isLinkableService = (service: string) => service !== "." && service !== "..";

/** The Alerts page's address that opens the form for a route rule, filled in. */
export const addRuleSearch = (environment: string, service: string, route?: string) => ({
  add: "route_latency" as const,
  service,
  ...(route === undefined || !isNamedRoute(route) ? {} : { route }),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
});

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
  /** The live view instead of the period's records; the period stays for when it is off. */
  live?: boolean | undefined;
}

export const logsSearchOf = ({ range, environment, filters, live }: LogsSearch) => ({
  ...rangeSearch(range),
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

/**
 * A metric's page's address, besides its name: its kind, the split and
 * measure shown, and what it reads only (one host, one attribute value).
 */
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

/** The host and attribute value a metric's address narrows it to. */
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
