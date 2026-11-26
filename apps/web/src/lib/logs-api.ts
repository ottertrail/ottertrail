import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import {
  isListOf,
  isNumber,
  isRecord,
  isText,
  isTextMap,
  isTextOrNull,
  telemetryRetry,
} from "./telemetry-shapes";

/** A record as lists have it: the whole record comes when it is opened (logQuery). */
export interface LogSummary {
  id: string;
  time: string;
  /** Nanoseconds since 1970, as text: what finds the whole record. */
  timeNs: string;
  /** 0: the sender named none; 1 to 24 as OpenTelemetry numbers them. */
  severityNumber: number;
  severityText: string;
  /** The first 1,000 characters. */
  body: string;
  /** The body is longer than `body`. */
  bodyTruncated: boolean;
  traceId: string | null;
  spanId: string | null;
  eventName: string;
  service: string;
  environment: string;
}

/** GET /api/projects/:id/logs/:logId: one whole record. */
export interface LogRecord extends Omit<LogSummary, "bodyTruncated"> {
  observedTime: string;
  release: string;
  attributes: Record<string, string>;
  resourceAttributes: Record<string, string>;
  scope: { name: string; version: string };
}

/** GET /api/projects/:id/logs: one page, newest first. */
export interface LogList {
  timeZone: string;
  environment: string;
  environments: string[];
  services: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  logs: LogSummary[];
  next: string | null;
  /** Whether the project has sent any log record at all. */
  received: boolean;
}

/**
 * OpenTelemetry's severity ranges, lowest first: each covers four numbers
 * (TRACE 1 to 4, … FATAL 21 to 24). A minimum leaves out records with none.
 */
export const SEVERITIES = [
  { value: "trace", label: "Trace", from: 1 },
  { value: "debug", label: "Debug", from: 5 },
  { value: "info", label: "Info", from: 9 },
  { value: "warn", label: "Warning", from: 13 },
  { value: "error", label: "Error", from: 17 },
  { value: "fatal", label: "Fatal", from: 21 },
] as const;

export type Severity = (typeof SEVERITIES)[number]["value"];

export const isSeverity = (value: unknown): value is Severity =>
  SEVERITIES.some((item) => item.value === value);

/** The severity range a number falls in; undefined for 0, none named. */
export const severityOf = (number: number) =>
  SEVERITIES.findLast((item) => number >= item.from && number <= 24);

export interface LogFilters {
  service?: string | undefined;
  severity?: Severity | undefined;
  search?: string | undefined;
  traceId?: string | undefined;
}

/**
 * A time window the page opens on instead of its days, as an alert's link sends it: instants
 * in UTC, `end` excluded, at most a day apart.
 */
export interface LogWindow {
  start: string;
  end: string;
}

const MAX_WINDOW_MS = 86_400_000;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function logWindowFrom(search: { start?: unknown; end?: unknown }): LogWindow | undefined {
  const { start, end } = search;
  if (typeof start !== "string" || typeof end !== "string") return undefined;
  if (!INSTANT.test(start) || !INSTANT.test(end)) return undefined;
  const span = Date.parse(end) - Date.parse(start);
  return span > 0 && span <= MAX_WINDOW_MS ? { start, end } : undefined;
}

/** Trace IDs as the API takes them: 32 hex digits. */
export const isTraceId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-fA-F]{32}$/.test(value);

const isSummaryFields = (value: Record<string, unknown>) =>
  isText(value.id) &&
  isText(value.time) &&
  isText(value.timeNs) &&
  isNumber(value.severityNumber) &&
  isText(value.severityText) &&
  isText(value.body) &&
  isTextOrNull(value.traceId) &&
  isTextOrNull(value.spanId) &&
  isText(value.eventName) &&
  isText(value.service) &&
  isText(value.environment);

export const isLogSummary = (value: unknown): value is LogSummary =>
  isRecord(value) && isSummaryFields(value) && typeof value.bodyTruncated === "boolean";

const isLogRecord = (value: unknown): value is LogRecord =>
  isRecord(value) &&
  isSummaryFields(value) &&
  isText(value.observedTime) &&
  isText(value.release) &&
  isTextMap(value.attributes) &&
  isTextMap(value.resourceAttributes) &&
  isRecord(value.scope) &&
  isText(value.scope.name) &&
  isText(value.scope.version);

const isLogList = (value: unknown): value is LogList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isListOf(value.services, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isListOf(value.logs, isLogSummary) &&
  isTextOrNull(value.next) &&
  typeof value.received === "boolean";

function filterParams(environment: string, filters: LogFilters): Record<string, string> {
  return {
    ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
    ...(filters.service === undefined ? {} : { service: filters.service }),
    ...(filters.severity === undefined ? {} : { severity: filters.severity }),
    ...(filters.search === undefined ? {} : { search: filters.search }),
    ...(filters.traceId === undefined ? {} : { traceId: filters.traceId }),
  };
}

/** The days, or the time window that replaces them. */
const periodParams = (range: PageRange, window: LogWindow | undefined): Record<string, string> =>
  window === undefined ? rangeParams(range) : { start: window.start, end: window.end };

/** The filters in a query key, each by name, so one left undefined and one left out are one query. */
const filterKey = (filters: LogFilters) => [
  filters.service ?? null,
  filters.severity ?? null,
  filters.search ?? null,
  filters.traceId ?? null,
];

/** A severity range on the chart, or "none" for records that name none. */
export const SEVERITY_LEVELS = [
  "none",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/** GET /api/projects/:id/logs/volume: the search's records per time bucket and severity range. */
export interface LogVolume {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  /** The first bucket's start, ISO. */
  start: string;
  /** Each bucket's start, ISO, on the clock of the instance's timezone. */
  bucketStarts: string[];
  stepSeconds: number;
  buckets: number;
  counts: Record<SeverityLevel, number[]>;
  total: number;
}

const isCounts = (value: unknown): value is Record<SeverityLevel, number[]> =>
  isRecord(value) && SEVERITY_LEVELS.every((level) => isListOf(value[level], isNumber));

const isLogVolume = (value: unknown): value is LogVolume =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isText(value.start) &&
  isListOf(value.bucketStarts, isText) &&
  isNumber(value.stepSeconds) &&
  isNumber(value.buckets) &&
  isCounts(value.counts) &&
  isNumber(value.total);

/** The chart above the logs list: the same range, environment, and filters. */
export const logVolumeQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: LogFilters,
  window?: LogWindow,
) =>
  queryOptions({
    queryKey: ["logs-volume", projectId, window ?? range, environment, ...filterKey(filters)],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...periodParams(range, window),
        ...filterParams(environment, filters),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/logs/volume?${query.toString()}`,
          { signal },
        ),
        isLogVolume,
      );
    },
    placeholderData: keepPreviousData,
  });

/** GET /api/projects/:id/logs/live: records that arrived after the cursor. */
export interface LiveLogs {
  timeZone: string;
  environment: string;
  /** Newest arrival first. */
  logs: LogSummary[];
  /** Where the next poll starts: an arrival, in nanoseconds since 1970. */
  cursor: string;
  /** Records that arrived after the cursor but were not sent: more than a page came at once. */
  skipped: number;
  /** The cursor was older than the API's window: what arrived from `from` to `to` is not read. */
  gap: { from: string; to: string } | null;
}

const isGap = (value: unknown): value is { from: string; to: string } =>
  isRecord(value) && isText(value.from) && isText(value.to);

const isLiveLogs = (value: unknown): value is LiveLogs =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.logs, isLogSummary) &&
  isText(value.cursor) &&
  isNumber(value.skipped) &&
  (value.gap === null || isGap(value.gap));

/** One poll of the live view. */
export async function fetchLiveLogs(
  projectId: string,
  environment: string,
  filters: LogFilters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<LiveLogs> {
  const query = new URLSearchParams({
    ...filterParams(environment, filters),
    ...(cursor === null ? {} : { after: cursor }),
  });
  return expectShape(
    await apiRequest(
      `/api/projects/${encodeURIComponent(projectId)}/logs/live?${query.toString()}`,
      { signal },
    ),
    isLiveLogs,
  );
}

/** The project's log records, newest first, a page at a time ("Load older"). */
export const logsQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: LogFilters,
  window?: LogWindow,
) =>
  infiniteQueryOptions({
    // Each filter by name, so a filter left undefined and one left out are the same query.
    queryKey: ["logs", projectId, window ?? range, environment, ...filterKey(filters)],
    retry: telemetryRetry,
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...periodParams(range, window),
        ...filterParams(environment, filters),
        ...(pageParam === null ? {} : { before: pageParam }),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/logs?${query.toString()}`,
          { signal },
        ),
        isLogList,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    placeholderData: keepPreviousData,
  });

const isLogAnswer = (value: unknown): value is { timeZone: string; log: LogRecord } =>
  isRecord(value) && isText(value.timeZone) && isLogRecord(value.log);

export const logQuery = (projectId: string, log: LogSummary) =>
  queryOptions({
    queryKey: ["log", projectId, log.id, log.timeNs],
    retry: telemetryRetry,
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/logs/${encodeURIComponent(
            log.id,
          )}?time=${encodeURIComponent(log.timeNs)}`,
          { signal },
        ),
        isLogAnswer,
      ),
    // A record never changes once stored.
    staleTime: Number.POSITIVE_INFINITY,
  });
