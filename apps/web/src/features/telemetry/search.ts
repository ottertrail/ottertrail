import { DEFAULT_ENVIRONMENT, DEFAULT_PERIOD, type PageRange } from "@/lib/analytics-api";
import { isSeverity, isTraceId, type LogFilters } from "@/lib/logs-api";
import { MIN_DURATIONS, type TraceFilters } from "@/lib/traces-api";

/** The days in an address: left out for the default period. */
const rangeSearch = (range: PageRange) =>
  "period" in range
    ? range.period === DEFAULT_PERIOD
      ? {}
      : { period: range.period }
    : { from: range.from, to: range.to };

const environmentSearch = (environment: string) =>
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
