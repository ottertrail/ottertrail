import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, telemetryRetry } from "./telemetry-shapes";

/** A request's status class, from its HTTP status code; "none" without one from 200 to 599. */
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "none"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];
export type StatusCounts = Record<StatusClass, number>;

export interface RouteStats {
  requests: number;
  failed: number;
  /** Median duration, in microseconds. */
  p50Us: number;
  p95Us: number;
  p99Us: number;
  /** The requests by status class; they add up to `requests`. */
  statuses: StatusCounts;
}

export interface ServiceSummary extends RouteStats {
  service: string;
  /** All its routes in the range; `routes` holds the 100 busiest. */
  routeCount: number;
  routes: (RouteStats & { route: string })[];
}

/** GET /api/projects/:id/services */
export interface ServiceList {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  /** Busiest first. */
  services: ServiceSummary[];
  truncated: boolean;
  /** Whether the project has sent any span at all. */
  received: boolean;
}

const isPerClass = (value: unknown, isItem: (item: unknown) => boolean) =>
  isRecord(value) && STATUS_CLASSES.every((name) => isItem(value[name]));

const isStats = (value: Record<string, unknown>) =>
  isNumber(value.requests) &&
  isNumber(value.failed) &&
  isNumber(value.p50Us) &&
  isNumber(value.p95Us) &&
  isNumber(value.p99Us) &&
  isPerClass(value.statuses, isNumber);

const isRoute = (value: unknown): value is RouteStats & { route: string } =>
  isRecord(value) && isText(value.route) && isStats(value);

const isService = (value: unknown): value is ServiceSummary =>
  isRecord(value) &&
  isText(value.service) &&
  isStats(value) &&
  isNumber(value.routeCount) &&
  isListOf(value.routes, isRoute);

const isServiceList = (value: unknown): value is ServiceList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isListOf(value.services, isService) &&
  typeof value.truncated === "boolean" &&
  typeof value.received === "boolean";

/** GET /api/projects/:id/services/routes: distinct services and routes of the last day. */
export interface RecentRoutes {
  environment: string;
  maxRoutes: number;
  routes: { service: string; route: string }[];
  truncated: boolean;
}

const isRecentRoutes = (value: unknown): value is RecentRoutes =>
  isRecord(value) &&
  isText(value.environment) &&
  isNumber(value.maxRoutes) &&
  isListOf(
    value.routes,
    (item): item is { service: string; route: string } =>
      isRecord(item) && isText(item.service) && isText(item.route),
  ) &&
  typeof value.truncated === "boolean";

/** Up to 200 services and routes of the last day: what the alert form suggests. */
export const recentRoutesQuery = (projectId: string, environment: string) =>
  queryOptions({
    queryKey: ["services", projectId, "recent-routes", environment],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams(environment === DEFAULT_ENVIRONMENT ? {} : { environment });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/services/routes?${query.toString()}`,
          { signal },
        ),
        isRecentRoutes,
      );
    },
    placeholderData: keepPreviousData,
  });

/** Each service's and route's requests, failures, and durations in the range. */
export const servicesQuery = (projectId: string, range: PageRange, environment: string) =>
  queryOptions({
    queryKey: ["services", projectId, range, environment],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/services?${query.toString()}`,
          { signal },
        ),
        isServiceList,
      );
    },
    placeholderData: keepPreviousData,
  });

/** GET /api/projects/:id/services/chart: one service, or one of its routes, over the period. */
export interface ServiceChart {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  service: string;
  /** null: every route of the service. */
  route: string | null;
  /** The first bucket's start, ISO. */
  start: string;
  stepSeconds: number;
  buckets: number;
  /** The whole period, as the Services page counts it. */
  totals: RouteStats;
  counts: { requests: number[]; failed: number[]; statuses: Record<StatusClass, number[]> };
  perSecond: Record<StatusClass, (number | null)[]>;
  /** 0 to 1; null without a request. */
  failedShare: (number | null)[];
  /** Microseconds; null without a request. */
  durations: { p50Us: (number | null)[]; p95Us: (number | null)[]; p99Us: (number | null)[] };
}

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);
const isNumbers = (value: unknown): value is number[] => isListOf(value, isNumber);
const isNumbersOrNulls = (value: unknown): value is (number | null)[] =>
  isListOf(value, isNumberOrNull);

const isServiceChart = (value: unknown): value is ServiceChart =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isText(value.service) &&
  (value.route === null || isText(value.route)) &&
  isText(value.start) &&
  isNumber(value.stepSeconds) &&
  isNumber(value.buckets) &&
  isRecord(value.totals) &&
  isStats(value.totals) &&
  isRecord(value.counts) &&
  isNumbers(value.counts.requests) &&
  isNumbers(value.counts.failed) &&
  isPerClass(value.counts.statuses, isNumbers) &&
  isPerClass(value.perSecond, isNumbersOrNulls) &&
  isNumbersOrNulls(value.failedShare) &&
  isRecord(value.durations) &&
  isNumbersOrNulls(value.durations.p50Us) &&
  isNumbersOrNulls(value.durations.p95Us) &&
  isNumbersOrNulls(value.durations.p99Us);

/** One service's requests, or one route's, over the period, in time buckets. */
export const serviceChartQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  service: string,
  route: string | undefined,
) =>
  queryOptions({
    queryKey: ["services", projectId, "chart", range, environment, service, route ?? null],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
        service,
        ...(route === undefined ? {} : { route }),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/services/chart?${query.toString()}`,
          { signal },
        ),
        isServiceChart,
      );
    },
    placeholderData: keepPreviousData,
  });

/** GET /api/projects/:id/services/trend: every service's requests together, over the period. */
export type ServicesTrend = Omit<ServiceChart, "environments" | "service" | "route">;

const isServicesTrend = (value: unknown): value is ServicesTrend =>
  isRecord(value) && isServiceChart({ ...value, environments: [], service: "", route: null });

/** Every service's requests over the period, in time buckets: the charts above the Services list. */
export const servicesTrendQuery = (projectId: string, range: PageRange, environment: string) =>
  queryOptions({
    queryKey: ["services", projectId, "trend", range, environment],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/services/trend?${query.toString()}`,
          { signal },
        ),
        isServicesTrend,
      );
    },
    placeholderData: keepPreviousData,
  });
