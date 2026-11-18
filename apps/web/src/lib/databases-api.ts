import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, telemetryRetry } from "./telemetry-shapes";

/** What a database's query shapes are ordered by, largest first; the API keeps the first 200. */
export const DATABASE_SORTS = ["time", "p95", "calls", "failures"] as const;
export type DatabaseSort = (typeof DATABASE_SORTS)[number];
export const DEFAULT_DATABASE_SORT: DatabaseSort = "time";

export const isDatabaseSort = (value: unknown): value is DatabaseSort =>
  typeof value === "string" && (DATABASE_SORTS as readonly string[]).includes(value);

/** Where a shape comes from: the summary sent, the query text normalized, or the operation and collection. */
export type ShapeKind = "summary" | "query" | "operation";
const isShapeKind = (value: unknown): value is ShapeKind =>
  value === "summary" || value === "query" || value === "operation";

export interface CallStats {
  calls: number;
  failed: number;
  /** The time all the calls took, added up, in microseconds. */
  totalUs: number;
  /** Calls per second over the period before now; null for a period with no time. */
  perSecond: number | null;
  /** In microseconds. */
  p50Us: number;
  p95Us: number;
  p99Us: number;
  /** Up to 10 of the services that made the calls, by name. */
  services: string[];
  serviceCount: number;
}

export interface ShapeSummary extends CallStats {
  /** The shape page's address. */
  id: string;
  kind: ShapeKind;
  shape: string;
}

export interface DatabaseSummary extends CallStats {
  system: string;
  /** "" when the calls name none. */
  database: string;
  /** All its shapes in the period: more than `shapes` holds when it was cut. */
  shapeCount: number;
  shapes: ShapeSummary[];
}

/** GET /api/projects/:id/databases */
export interface DatabaseList {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  sort: DatabaseSort;
  /** By time spent, most first. */
  databases: DatabaseSummary[];
  /** More than 50 databases: the list holds those with the most time spent. */
  truncated: boolean;
  /** Whether the project has sent any span at all. */
  received: boolean;
  seconds: number;
}

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);
const isNumbers = (value: unknown): value is number[] => isListOf(value, isNumber);
const isNumbersOrNulls = (value: unknown): value is (number | null)[] =>
  isListOf(value, isNumberOrNull);

const isStats = (value: Record<string, unknown>) =>
  isNumber(value.calls) &&
  isNumber(value.failed) &&
  isNumber(value.totalUs) &&
  isNumberOrNull(value.perSecond) &&
  isNumber(value.p50Us) &&
  isNumber(value.p95Us) &&
  isNumber(value.p99Us);

const isNamed = (value: Record<string, unknown>) =>
  isListOf(value.services, isText) && isNumber(value.serviceCount);

const isShape = (value: unknown): value is ShapeSummary =>
  isRecord(value) &&
  isText(value.id) &&
  isShapeKind(value.kind) &&
  isText(value.shape) &&
  isStats(value) &&
  isNamed(value);

const isDatabase = (value: unknown): value is DatabaseSummary =>
  isRecord(value) &&
  isText(value.system) &&
  isText(value.database) &&
  isStats(value) &&
  isNamed(value) &&
  isNumber(value.shapeCount) &&
  isListOf(value.shapes, isShape);

const isAnswered = (value: Record<string, unknown>) =>
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays);

const isDatabaseList = (value: unknown): value is DatabaseList =>
  isRecord(value) &&
  isAnswered(value) &&
  isDatabaseSort(value.sort) &&
  isListOf(value.databases, isDatabase) &&
  typeof value.truncated === "boolean" &&
  typeof value.received === "boolean" &&
  isNumber(value.seconds);

/** Each database's calls and query shapes in the period, the shapes in `sort`'s order. */
export const databasesQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  sort: DatabaseSort,
) =>
  queryOptions({
    queryKey: ["databases", projectId, range, environment, sort],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
        ...(sort === DEFAULT_DATABASE_SORT ? {} : { sort }),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/databases?${query.toString()}`,
          { signal },
        ),
        isDatabaseList,
      );
    },
    placeholderData: keepPreviousData,
  });

/** One of a shape's slowest calls. */
export interface SlowCall {
  traceId: string;
  spanId: string;
  /** ISO, to the millisecond. */
  start: string;
  durationUs: number;
  service: string;
  failed: boolean;
}

/** GET /api/projects/:id/databases/shapes/:shapeId */
export interface ShapeDetail {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  id: string;
  /** null: no call of the shape in the period. */
  shape: { kind: ShapeKind; text: string; system: string; database: string } | null;
  /** The first bucket's start, ISO. */
  start: string;
  stepSeconds: number;
  buckets: number;
  /** The whole period, as the Databases page counts it. */
  totals: CallStats;
  counts: { calls: number[]; failed: number[] };
  perSecond: (number | null)[];
  /** 0 to 1; null without a call. */
  failedShare: (number | null)[];
  /** Microseconds; null without a call. */
  durations: { p50Us: (number | null)[]; p95Us: (number | null)[]; p99Us: (number | null)[] };
  /** Most calls first. */
  services: (Omit<CallStats, "services" | "serviceCount"> & { service: string })[];
  servicesTruncated: boolean;
  slowest: SlowCall[];
  /** The routes of the requests behind the latest calls; route null: no request found. */
  callers: { service: string; route: string | null; calls: number }[];
  /** How many of the latest calls the callers come from. */
  sampled: number;
}

const isSlowCall = (value: unknown): value is SlowCall =>
  isRecord(value) &&
  isText(value.traceId) &&
  isText(value.spanId) &&
  isText(value.start) &&
  isNumber(value.durationUs) &&
  isText(value.service) &&
  typeof value.failed === "boolean";

const isShapeDetail = (value: unknown): value is ShapeDetail =>
  isRecord(value) &&
  isAnswered(value) &&
  isText(value.id) &&
  (value.shape === null ||
    (isRecord(value.shape) &&
      isShapeKind(value.shape.kind) &&
      isText(value.shape.text) &&
      isText(value.shape.system) &&
      isText(value.shape.database))) &&
  isText(value.start) &&
  isNumber(value.stepSeconds) &&
  isNumber(value.buckets) &&
  isRecord(value.totals) &&
  isStats(value.totals) &&
  isRecord(value.counts) &&
  isNumbers(value.counts.calls) &&
  isNumbers(value.counts.failed) &&
  isNumbersOrNulls(value.perSecond) &&
  isNumbersOrNulls(value.failedShare) &&
  isRecord(value.durations) &&
  isNumbersOrNulls(value.durations.p50Us) &&
  isNumbersOrNulls(value.durations.p95Us) &&
  isNumbersOrNulls(value.durations.p99Us) &&
  isListOf(
    value.services,
    (item): item is ShapeDetail["services"][number] =>
      isRecord(item) && isText(item.service) && isStats(item),
  ) &&
  typeof value.servicesTruncated === "boolean" &&
  isListOf(value.slowest, isSlowCall) &&
  isListOf(
    value.callers,
    (item): item is ShapeDetail["callers"][number] =>
      isRecord(item) &&
      isText(item.service) &&
      (item.route === null || isText(item.route)) &&
      isNumber(item.calls),
  ) &&
  isNumber(value.sampled);

/** One query shape over the period. */
export const shapeQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  shapeId: string,
) =>
  queryOptions({
    queryKey: ["databases", projectId, "shape", shapeId, range, environment],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/databases/shapes/${encodeURIComponent(shapeId)}?${query.toString()}`,
          { signal },
        ),
        isShapeDetail,
      );
    },
    // Another period or environment keeps the shape's last answer, dimmed;
    // another shape never shows this one's.
    placeholderData: (previous) => (previous?.id === shapeId ? previous : undefined),
  });

const MAX_SHAPE_ID = 18_446_744_073_709_551_615n;

/** A shape's ID as an address may hold it: a UInt64 in decimal (leading zeros allowed). */
export const isShapeId = (value: string) =>
  /^[0-9]{1,30}$/.test(value) && BigInt(value) <= MAX_SHAPE_ID;

/** A shape's ID as the API gives it: without leading zeros. Only for an ID isShapeId accepts. */
export const canonicalShapeId = (value: string) => BigInt(value).toString();
