import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, isTextMap, isTextOrNull } from "./telemetry-shapes";

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

/** The project's log records, newest first, a page at a time ("Load older"). */
export const logsQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: LogFilters,
) =>
  infiniteQueryOptions({
    // Each filter by name, so a filter left undefined and one left out are the same query.
    queryKey: [
      "logs",
      projectId,
      range,
      environment,
      filters.service ?? null,
      filters.severity ?? null,
      filters.search ?? null,
      filters.traceId ?? null,
    ],
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
        ...(filters.service === undefined ? {} : { service: filters.service }),
        ...(filters.severity === undefined ? {} : { severity: filters.severity }),
        ...(filters.search === undefined ? {} : { search: filters.search }),
        ...(filters.traceId === undefined ? {} : { traceId: filters.traceId }),
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

/** One whole record: its body, attributes, and resource attributes, read when it is opened. */
export const logQuery = (projectId: string, log: LogSummary) =>
  queryOptions({
    queryKey: ["log", projectId, log.id, log.timeNs],
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
