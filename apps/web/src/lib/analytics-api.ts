import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/** Ranges the analytics page offers; each ends today in the instance's timezone. */
export const PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "12m", label: "Last 12 months" },
] as const;

export type Period = (typeof PERIODS)[number]["value"];

/** The period a page opens with when its address names none. */
export const DEFAULT_PERIOD: Period = "7d";

export const isPeriod = (value: unknown): value is Period =>
  PERIODS.some((period) => period.value === value);

export interface Summary {
  visitors: number;
  pageviews: number;
  visits: number;
  viewsPerVisit: number | null;
  bounceRate: number | null;
  avgDurationMs: number | null;
  avgEngagedMs: number | null;
}

export interface DayPoint {
  day: string;
  visitors: number;
  pageviews: number;
  visits: number;
}

export interface PageRow {
  path: string;
  pageviews: number;
  visitors: number;
  avgEngagedMs: number | null;
}

export interface BreakdownRow {
  /** null: unknown (no referrer host, no location, an unrecognized browser …). */
  value: string | null;
  visitors: number;
  visits: number;
  bounceRate: number | null;
}

export interface CustomEventRow {
  name: string;
  events: number;
  visitors: number;
}

export const BREAKDOWNS = [
  "source",
  "utmCampaign",
  "entryPage",
  "exitPage",
  "country",
  "region",
  "city",
  "deviceType",
  "browser",
  "os",
] as const;

export type Breakdown = (typeof BREAKDOWNS)[number];

/** GET /api/projects/:id/analytics */
export interface Analytics {
  timeZone: string;
  firstDay: string;
  lastDay: string;
  summary: Summary;
  days: DayPoint[];
  pages: PageRow[];
  breakdowns: Record<Breakdown, BreakdownRow[]>;
  customEvents: CustomEventRow[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number";
const isNumberOrNull = (value: unknown) => value === null || isNumber(value);
const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);

const isSummary = (value: unknown): value is Summary =>
  isRecord(value) &&
  isNumber(value.visitors) &&
  isNumber(value.pageviews) &&
  isNumber(value.visits) &&
  isNumberOrNull(value.viewsPerVisit) &&
  isNumberOrNull(value.bounceRate) &&
  isNumberOrNull(value.avgDurationMs) &&
  isNumberOrNull(value.avgEngagedMs);

const isDayPoint = (value: unknown): value is DayPoint =>
  isRecord(value) &&
  typeof value.day === "string" &&
  isNumber(value.visitors) &&
  isNumber(value.pageviews) &&
  isNumber(value.visits);

const isPageRow = (value: unknown): value is PageRow =>
  isRecord(value) &&
  typeof value.path === "string" &&
  isNumber(value.pageviews) &&
  isNumber(value.visitors) &&
  isNumberOrNull(value.avgEngagedMs);

const isBreakdownRow = (value: unknown): value is BreakdownRow =>
  isRecord(value) &&
  (value.value === null || typeof value.value === "string") &&
  isNumber(value.visitors) &&
  isNumber(value.visits) &&
  isNumberOrNull(value.bounceRate);

const isCustomEventRow = (value: unknown): value is CustomEventRow =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isNumber(value.events) &&
  isNumber(value.visitors);

export const isAnalytics = (value: unknown): value is Analytics =>
  isRecord(value) &&
  typeof value.timeZone === "string" &&
  typeof value.firstDay === "string" &&
  typeof value.lastDay === "string" &&
  isSummary(value.summary) &&
  isListOf(value.days, isDayPoint) &&
  isListOf(value.pages, isPageRow) &&
  isListOf(value.customEvents, isCustomEventRow) &&
  isRecord(value.breakdowns) &&
  BREAKDOWNS.every((name) =>
    isListOf(isRecord(value.breakdowns) ? value.breakdowns[name] : undefined, isBreakdownRow),
  );

/** How often a page that shows today refreshes on its own. */
const REFRESH_MS = 60_000;

export const analyticsQuery = (projectId: string, period: Period) =>
  queryOptions({
    queryKey: ["analytics", projectId, period],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/analytics?period=${period}`,
          { signal },
        ),
        isAnalytics,
      ),
    // While another period loads, keep showing this one (dimmed), not skeletons.
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  });
