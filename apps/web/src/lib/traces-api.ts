import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isLogSummary, type LogSummary } from "./logs-api";
import {
  isListOf,
  isNumber,
  isRecord,
  isText,
  isTextMap,
  isTextOrNull,
  telemetryRetry,
} from "./telemetry-shapes";

export type SpanKind = "unspecified" | "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = "unset" | "ok" | "error";

/** A trace as the list shows it: its root span. */
export interface TraceSummary {
  traceId: string;
  spanId: string;
  service: string;
  name: string;
  start: string;
  durationUs: number;
  /** A span of the trace failed. */
  error: boolean;
  spans: number;
}

/** GET /api/projects/:id/traces: one page, newest first. */
export interface TraceList {
  timeZone: string;
  environment: string;
  environments: string[];
  /** The environment's services with root spans in the range. */
  services: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  traces: TraceSummary[];
  /** The cursor to the next, older page; null on the last. */
  next: string | null;
  /** Whether the project has sent any span at all. */
  received: boolean;
}

export interface WaterfallSpan {
  spanId: string;
  /** "" for a root. */
  parentSpanId: string;
  name: string;
  service: string;
  kind: SpanKind;
  status: SpanStatus;
  /** Nanoseconds since 1970, as text: what finds the span's detail. */
  startNs: string;
  offsetUs: number;
  durationUs: number;
}

/** GET /api/projects/:id/traces/:traceId */
export interface TraceDetail {
  traceId: string;
  timeZone: string;
  retentionDays: number;
  /** null: no span of it is kept. */
  start: string | null;
  durationUs: number;
  spans: WaterfallSpan[];
  totalSpans: number;
  logs: LogSummary[];
  logsTruncated: boolean;
}

export interface SpanEvent {
  name: string;
  time: string | null;
  offsetUs: number | null;
  attributes: Record<string, string>;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes: Record<string, string>;
}

export interface SpanDetail {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  statusMessage: string;
  service: string;
  release: string;
  environment: string;
  start: string;
  durationUs: number;
  attributes: Record<string, string>;
  resourceAttributes: Record<string, string>;
  droppedAttributes: number;
  events: SpanEvent[];
  droppedEvents: number;
  links: SpanLink[];
  droppedLinks: number;
  scope: { name: string; version: string };
}

/** The list's filters besides the range and environment. */
export interface TraceFilters {
  service?: string | undefined;
  name?: string | undefined;
  errors?: boolean | undefined;
  /** Milliseconds. */
  minDuration?: number | undefined;
}

/** Minimum durations the list offers, in milliseconds. */
export const MIN_DURATIONS = [10, 100, 500, 1000, 5000] as const;

const KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"];
const isKind = (value: unknown): value is SpanKind => KINDS.some((kind) => kind === value);
const isStatus = (value: unknown): value is SpanStatus =>
  value === "unset" || value === "ok" || value === "error";

const isTraceSummary = (value: unknown): value is TraceSummary =>
  isRecord(value) &&
  isText(value.traceId) &&
  isText(value.spanId) &&
  isText(value.service) &&
  isText(value.name) &&
  isText(value.start) &&
  isNumber(value.durationUs) &&
  typeof value.error === "boolean" &&
  isNumber(value.spans);

const isTraceList = (value: unknown): value is TraceList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isListOf(value.services, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isListOf(value.traces, isTraceSummary) &&
  isTextOrNull(value.next) &&
  typeof value.received === "boolean";

const isWaterfallSpan = (value: unknown): value is WaterfallSpan =>
  isRecord(value) &&
  isText(value.spanId) &&
  isText(value.parentSpanId) &&
  isText(value.name) &&
  isText(value.service) &&
  isKind(value.kind) &&
  isStatus(value.status) &&
  isText(value.startNs) &&
  isNumber(value.offsetUs) &&
  isNumber(value.durationUs);

const isTraceDetail = (value: unknown): value is TraceDetail =>
  isRecord(value) &&
  isText(value.traceId) &&
  isText(value.timeZone) &&
  isNumber(value.retentionDays) &&
  isTextOrNull(value.start) &&
  isNumber(value.durationUs) &&
  isListOf(value.spans, isWaterfallSpan) &&
  isNumber(value.totalSpans) &&
  isListOf(value.logs, isLogSummary) &&
  typeof value.logsTruncated === "boolean";

const isSpanEvent = (value: unknown): value is SpanEvent =>
  isRecord(value) &&
  isText(value.name) &&
  isTextOrNull(value.time) &&
  (value.offsetUs === null || isNumber(value.offsetUs)) &&
  isTextMap(value.attributes);

const isSpanLink = (value: unknown): value is SpanLink =>
  isRecord(value) && isText(value.traceId) && isText(value.spanId) && isTextMap(value.attributes);

const isSpanDetail = (value: unknown): value is SpanDetail =>
  isRecord(value) &&
  isText(value.traceId) &&
  isText(value.spanId) &&
  isText(value.parentSpanId) &&
  isText(value.name) &&
  isKind(value.kind) &&
  isStatus(value.status) &&
  isText(value.statusMessage) &&
  isText(value.service) &&
  isText(value.release) &&
  isText(value.environment) &&
  isText(value.start) &&
  isNumber(value.durationUs) &&
  isTextMap(value.attributes) &&
  isTextMap(value.resourceAttributes) &&
  isNumber(value.droppedAttributes) &&
  isListOf(value.events, isSpanEvent) &&
  isNumber(value.droppedEvents) &&
  isListOf(value.links, isSpanLink) &&
  isNumber(value.droppedLinks) &&
  isRecord(value.scope) &&
  isText(value.scope.name) &&
  isText(value.scope.version);

const isSpanAnswer = (value: unknown): value is { timeZone: string; span: SpanDetail } =>
  isRecord(value) && isText(value.timeZone) && isSpanDetail(value.span);

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

/** The project's traces, newest first, a page at a time ("Load older"). */
export const tracesQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: TraceFilters,
) =>
  infiniteQueryOptions({
    // Each filter by name, so a filter left undefined and one left out are the same query.
    queryKey: [
      "traces",
      projectId,
      range,
      environment,
      filters.service ?? null,
      filters.name ?? null,
      filters.errors === true,
      filters.minDuration ?? null,
    ],
    retry: telemetryRetry,
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
        ...(filters.service === undefined ? {} : { service: filters.service }),
        ...(filters.name === undefined ? {} : { name: filters.name }),
        ...(filters.errors === true ? { errors: "true" } : {}),
        ...(filters.minDuration === undefined ? {} : { minDuration: String(filters.minDuration) }),
        ...(pageParam === null ? {} : { before: pageParam }),
      });
      return expectShape(
        await apiRequest(`${projectPath(projectId)}/traces?${query.toString()}`, { signal }),
        isTraceList,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    // While other filters load, keep showing these (dimmed).
    placeholderData: keepPreviousData,
  });

/** One trace's spans and logs; `at`, when known (an error's time), narrows where it is looked for. */
export const traceQuery = (projectId: string, traceId: string, at: string | undefined) =>
  queryOptions({
    queryKey: ["trace", projectId, traceId, at],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = at === undefined ? "" : `?${new URLSearchParams({ at }).toString()}`;
      return expectShape(
        await apiRequest(
          `${projectPath(projectId)}/traces/${encodeURIComponent(traceId)}${query}`,
          { signal },
        ),
        isTraceDetail,
      );
    },
  });

/** One span's attributes, events, and links. */
export const spanQuery = (projectId: string, traceId: string, span: WaterfallSpan) =>
  queryOptions({
    queryKey: ["span", projectId, traceId, span.spanId, span.startNs],
    retry: telemetryRetry,
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `${projectPath(projectId)}/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(
            span.spanId,
          )}?start=${encodeURIComponent(span.startNs)}`,
          { signal },
        ),
        isSpanAnswer,
      ),
    // A span never changes once stored.
    staleTime: Number.POSITIVE_INFINITY,
  });
