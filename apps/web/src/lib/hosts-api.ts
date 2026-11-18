import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import {
  isListOf,
  isNumber,
  isRecord,
  isText,
  isTextOrNull,
  telemetryRetry,
} from "./telemetry-shapes";

/** A host as the Hosts page lists it (apps/api/src/telemetry/hosts.ts). */
export interface HostSummary {
  /** Its resource's host.name. */
  host: string;
  lastSeen: string;
  /** Nothing from it in the last 5 minutes; null when the period ended before now. */
  stale: boolean | null;
  /** Each 0 to 100; null when it sent nothing to work it out from. */
  cpuPercent: number | null;
  memoryPercent: number | null;
  /** The fullest filesystem's used share, and its mount point. */
  filesystemPercent: number | null;
  filesystemMount: string | null;
  load1m: number | null;
}

/** GET /api/projects/:id/hosts */
export interface HostList {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  /** By name. */
  hosts: HostSummary[];
  /** More than 500 hosts: the first by name. */
  truncated: boolean;
  /** Whether the project has sent any host metric at all. */
  received: boolean;
}

export const HOST_CHART_IDS = [
  "cpu",
  "cpuStates",
  "memoryPercent",
  "memoryBytes",
  "filesystem",
  "network",
  "disk",
  "load",
] as const;
export type HostChartId = (typeof HOST_CHART_IDS)[number];

/** One line of a host's chart: a value per bucket, null where nothing arrived. */
export interface HostLine {
  /** What it stands for: a state ("idle"), a mount point, a direction, a load average's metric; null for none. */
  value: string | null;
  /** Values past eight, added up. */
  other: boolean;
  values: (number | null)[];
}

export interface HostChart {
  id: HostChartId;
  /** "%" (0 to 100), "By", "By/s", or "{thread}". */
  unit: string;
  /** The metrics it was worked out from; empty when the host sent none of them. */
  metrics: string[];
  lines: HostLine[];
  /** A metric had more series than a chart reads. */
  capped: boolean;
}

/** GET /api/projects/:id/hosts/charts */
export interface HostCharts {
  timeZone: string;
  environment: string;
  environments?: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  host: string;
  /** null: nothing from this host in the period. */
  lastSeen: string | null;
  /** As HostSummary's. */
  stale: boolean | null;
  start: string;
  stepSeconds: number;
  buckets: number;
  charts: HostChart[];
}

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);

const isHostSummary = (value: unknown): value is HostSummary =>
  isRecord(value) &&
  isText(value.host) &&
  isText(value.lastSeen) &&
  (value.stale === null || typeof value.stale === "boolean") &&
  isNumberOrNull(value.cpuPercent) &&
  isNumberOrNull(value.memoryPercent) &&
  isNumberOrNull(value.filesystemPercent) &&
  isTextOrNull(value.filesystemMount) &&
  isNumberOrNull(value.load1m);

const isHostList = (value: unknown): value is HostList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isListOf(value.hosts, isHostSummary) &&
  typeof value.truncated === "boolean" &&
  typeof value.received === "boolean";

const isLineOf =
  (buckets: number) =>
  (value: unknown): value is HostLine =>
    isRecord(value) &&
    isTextOrNull(value.value) &&
    typeof value.other === "boolean" &&
    isListOf(value.values, isNumberOrNull) &&
    value.values.length === buckets;

const isChartOf =
  (buckets: number) =>
  (value: unknown): value is HostChart =>
    isRecord(value) &&
    HOST_CHART_IDS.some((id) => id === value.id) &&
    isText(value.unit) &&
    isListOf(value.metrics, isText) &&
    isListOf(value.lines, isLineOf(buckets)) &&
    typeof value.capped === "boolean";

const isHostCharts = (value: unknown): value is HostCharts =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isText(value.host) &&
  isTextOrNull(value.lastSeen) &&
  (value.stale === null || typeof value.stale === "boolean") &&
  isText(value.start) &&
  isNumber(value.stepSeconds) &&
  isNumber(value.buckets) &&
  isListOf(value.charts, isChartOf(value.buckets));

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

const rangeQuery = (range: PageRange, environment: string) => ({
  ...rangeParams(range),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
});

/** The hosts that sent host metrics in the range, by name, with their latest values. */
export const hostsQuery = (projectId: string, range: PageRange, environment: string) =>
  queryOptions({
    queryKey: ["hosts", projectId, range, environment],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams(rangeQuery(range, environment));
      return expectShape(
        await apiRequest(`${projectPath(projectId)}/hosts?${query.toString()}`, { signal }),
        isHostList,
      );
    },
    placeholderData: keepPreviousData,
  });

/** One host's charts over the range. */
export const hostChartsQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  host: string,
) =>
  queryOptions({
    queryKey: ["host", projectId, range, environment, host],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ ...rangeQuery(range, environment), host });
      return expectShape(
        await apiRequest(`${projectPath(projectId)}/hosts/charts?${query.toString()}`, { signal }),
        isHostCharts,
      );
    },
    // Another host's charts never stand in for this one's while it loads.
    placeholderData: (previous) => (previous?.host === host ? previous : undefined),
  });
