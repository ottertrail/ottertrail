import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";

/** The Web Vitals the tracker measures; the first three are the Core Web Vitals. */
export const VITAL_NAMES = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
export type VitalName = (typeof VITAL_NAMES)[number];

export const CORE_VITALS = ["lcp", "inp", "cls"] as const;
export type CoreVital = (typeof CORE_VITALS)[number];

/** The device filter's choices; leaving it out means all devices. */
export const DEVICES = [
  { value: "desktop", label: "Desktop" },
  { value: "mobile", label: "Mobile" },
  { value: "tablet", label: "Tablet" },
] as const;

export type Device = (typeof DEVICES)[number]["value"];

export const isDevice = (value: unknown): value is Device =>
  DEVICES.some((item) => item.value === value);

/** One metric over the range. */
export interface MetricSummary {
  /** The 75th percentile; null when no page load had a value. */
  p75: number | null;
  /** Page loads with a value for this metric. */
  count: number;
  good: number;
  needsImprovement: number;
  poor: number;
}

/** The Core Web Vitals' p75 of a group of page loads; null when none had a value. */
export interface SpeedRow {
  /** Page loads with any value. */
  loads: number;
  lcp: number | null;
  inp: number | null;
  cls: number | null;
}

/** GET /api/projects/:id/speed */
export interface Speed {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  device: string | null;
  /** Good up to the first value, poor above the second. */
  thresholds: Record<VitalName, [number, number]>;
  /** Page loads with any value in the range. */
  loads: number;
  metrics: Record<VitalName, MetricSummary>;
  devices: (SpeedRow & { deviceType: string | null })[];
  /** The 20 pages with the most measured loads. */
  pages: (SpeedRow & { path: string })[];
  /** Every day of the range. */
  days: (SpeedRow & { day: string })[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isNumberOrNull = (value: unknown) => value === null || isNumber(value);
const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);

const isSummary = (value: unknown): value is MetricSummary =>
  isRecord(value) &&
  isNumberOrNull(value.p75) &&
  isNumber(value.count) &&
  isNumber(value.good) &&
  isNumber(value.needsImprovement) &&
  isNumber(value.poor);

const isRow = (value: unknown): value is SpeedRow =>
  isRecord(value) &&
  isNumber(value.loads) &&
  isNumberOrNull(value.lcp) &&
  isNumberOrNull(value.inp) &&
  isNumberOrNull(value.cls);

const isThreshold = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(isNumber);

const isDeviceRow = (item: unknown): item is Speed["devices"][number] =>
  isRecord(item) && isRow(item) && (item.deviceType === null || isText(item.deviceType));
const isPageRow = (item: unknown): item is Speed["pages"][number] =>
  isRecord(item) && isRow(item) && isText(item.path);
const isDayRow = (item: unknown): item is Speed["days"][number] =>
  isRecord(item) && isRow(item) && isText(item.day);

const isSpeed = (value: unknown): value is Speed =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  (value.device === null || isText(value.device)) &&
  isRecord(value.thresholds) &&
  isRecord(value.metrics) &&
  VITAL_NAMES.every(
    (name) =>
      isRecord(value.thresholds) &&
      isThreshold(value.thresholds[name]) &&
      isRecord(value.metrics) &&
      isSummary(value.metrics[name]),
  ) &&
  isNumber(value.loads) &&
  isListOf(value.devices, isDeviceRow) &&
  isListOf(value.pages, isPageRow) &&
  isListOf(value.days, isDayRow);

/** The project's Web Vitals in a range and an environment, on all devices or one kind. */
export const speedQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  device: Device | undefined,
) =>
  queryOptions({
    queryKey: ["speed", projectId, range, environment, device],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
        ...(device === undefined ? {} : { device }),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/speed?${query.toString()}`,
          { signal },
        ),
        isSpeed,
      );
    },
    // While another period or device loads, keep showing this one (dimmed).
    placeholderData: keepPreviousData,
  });
