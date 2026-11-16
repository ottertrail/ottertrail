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

/** The period before, for comparison: as many days, up to the same time of day when still running. */
export interface PreviousPeriod {
  firstDay: string;
  lastDay: string;
  /** Where the comparison stops on lastDay (ISO time), or null for the whole day. */
  until: string | null;
  summary: Summary;
}

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
  previous: PreviousPeriod;
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

const isPreviousPeriod = (value: unknown): value is PreviousPeriod =>
  isRecord(value) &&
  typeof value.firstDay === "string" &&
  typeof value.lastDay === "string" &&
  (value.until === null || typeof value.until === "string") &&
  isSummary(value.summary);

export const isAnalytics = (value: unknown): value is Analytics =>
  isRecord(value) &&
  typeof value.timeZone === "string" &&
  typeof value.firstDay === "string" &&
  typeof value.lastDay === "string" &&
  isSummary(value.summary) &&
  isListOf(value.days, isDayPoint) &&
  isListOf(value.pages, isPageRow) &&
  isListOf(value.customEvents, isCustomEventRow) &&
  isPreviousPeriod(value.previous) &&
  isRecord(value.breakdowns) &&
  BREAKDOWNS.every((name) =>
    isListOf(isRecord(value.breakdowns) ? value.breakdowns[name] : undefined, isBreakdownRow),
  );

/**
 * What the page can be filtered by, in the order filters are shown and
 * sent. "page" keeps visits that viewed the page; the others keep visits
 * whose property has the value, exactly as its list shows it.
 */
export const FILTER_NAMES = [
  "page",
  "entryPage",
  "exitPage",
  "source",
  "utmCampaign",
  "country",
  "region",
  "city",
  "deviceType",
  "browser",
  "os",
] as const satisfies readonly ("page" | Breakdown)[];

export type FilterName = (typeof FILTER_NAMES)[number];

/** Active filters by name. An empty string matches visits where the value is unknown. */
export type Filters = { [Name in FilterName]?: string | undefined };

export const FILTER_LABELS: Record<FilterName, string> = {
  page: "Page",
  entryPage: "Entry page",
  exitPage: "Exit page",
  source: "Source",
  utmCampaign: "Campaign",
  country: "Country",
  region: "Region",
  city: "City",
  deviceType: "Device",
  browser: "Browser",
  os: "Operating system",
};

/** The API refuses longer values; an address with one is treated as unfiltered for it. */
const MAX_FILTER_LENGTH = 2048;

/**
 * One filter's value from the address bar's query. The router may turn
 * "2024" into a number or "true" into a boolean, so those come back as text.
 */
function filterValue(value: unknown): string | undefined {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : undefined;
  // The API refuses NUL (PostgreSQL text cannot hold it) and overlong values.
  return text !== undefined && text.length <= MAX_FILTER_LENGTH && !text.includes("\u0000")
    ? text
    : undefined;
}

/**
 * Filters from the address bar's query. Every name is in the result,
 * undefined when absent or unusable (an object, an overlong value): the
 * router merges this over the raw query, so a name left out would keep its
 * raw, unchecked value. The type makes the compiler check that none is.
 */
export function filtersFrom(
  search: Record<string, unknown>,
): Record<FilterName, string | undefined> {
  return {
    page: filterValue(search.page),
    entryPage: filterValue(search.entryPage),
    exitPage: filterValue(search.exitPage),
    source: filterValue(search.source),
    utmCampaign: filterValue(search.utmCampaign),
    country: filterValue(search.country),
    region: filterValue(search.region),
    city: filterValue(search.city),
    deviceType: filterValue(search.deviceType),
    browser: filterValue(search.browser),
    os: filterValue(search.os),
  };
}

/** The active filters as [name, value] pairs, in FILTER_NAMES order. */
export function activeFilters(filters: Filters): [FilterName, string][] {
  return FILTER_NAMES.flatMap((name) => {
    const value = filters[name];
    return value === undefined ? [] : [[name, value] as [FilterName, string]];
  });
}

/** How often a page that shows today refreshes on its own. */
const REFRESH_MS = 60_000;

export const analyticsQuery = (projectId: string, period: Period, filters: Filters = {}) =>
  queryOptions({
    queryKey: ["analytics", projectId, period, filters],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ period, ...Object.fromEntries(activeFilters(filters)) });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/analytics?${query.toString()}`,
          { signal },
        ),
        isAnalytics,
      );
    },
    // While another period loads, keep showing this one (dimmed), not skeletons.
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  });
