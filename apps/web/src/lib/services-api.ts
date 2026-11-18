import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, telemetryRetry } from "./telemetry-shapes";

export interface RouteStats {
  requests: number;
  failed: number;
  /** Median duration, in microseconds. */
  p50Us: number;
  p95Us: number;
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

const isStats = (value: Record<string, unknown>) =>
  isNumber(value.requests) &&
  isNumber(value.failed) &&
  isNumber(value.p50Us) &&
  isNumber(value.p95Us);

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
