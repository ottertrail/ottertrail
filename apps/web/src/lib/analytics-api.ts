import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import { ApiError, apiRequest, expectShape } from "./api";

/** Ranges the analytics page offers; each ends today in the organization's timezone. */
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

/** The longest range the API answers, in days. */
export const MAX_RANGE_DAYS = 366;

/** The days the page shows: a period that ends today, or chosen days (both included). */
export type PageRange = { period: Period } | { from: string; to: string };

/** "YYYY-MM-DD" that names a real calendar day. */
export function isDay(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

/** Why chosen days cannot be shown, as the API would refuse them; null when they can. */
export function rangeProblem(from: string, to: string): string | null {
  if (!isDay(from) || !isDay(to)) {
    return "Choose a first and a last day.";
  }
  if (to < from) {
    return "The last day is before the first.";
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return days > MAX_RANGE_DAYS ? `A range covers at most ${MAX_RANGE_DAYS} days.` : null;
}

/**
 * The days an address asks for: chosen days when both are usable, else its
 * period, else the default. Unusable days fall back instead of failing.
 */
export function rangeFrom(search: { period?: unknown; from?: unknown; to?: unknown }): PageRange {
  const { from, to } = search;
  if (isDay(from) && isDay(to) && rangeProblem(from, to) === null) {
    return { from, to };
  }
  return { period: isPeriod(search.period) ? search.period : DEFAULT_PERIOD };
}

/** The range as the API's query parameters. */
export const rangeParams = (range: PageRange): Record<string, string> =>
  "period" in range ? { period: range.period } : { from: range.from, to: range.to };

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
  "release",
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

/** The environment a page shows when its address names none, as the API counts it. */
export const DEFAULT_ENVIRONMENT = "production";

/** As the API checks an environment's name: letters, digits, ".", "_", "-". */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The environment from the address bar's query, in lower case; the default when unusable. */
export function environmentFrom(value: unknown): string {
  return typeof value === "string" && ENVIRONMENT_PATTERN.test(value)
    ? value.toLowerCase()
    : DEFAULT_ENVIRONMENT;
}

/** GET /api/projects/:id/analytics */
export interface Analytics {
  timeZone: string;
  /** The environment every number counts, such as "production". */
  environment: string;
  /** The environments with events in the range, most events first, and the one shown. */
  environments: string[];
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
  typeof value.environment === "string" &&
  isListOf(value.environments, (item): item is string => typeof item === "string") &&
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
  "release",
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
  release: "Release",
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
    release: filterValue(search.release),
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

/** The API's environment parameter: left out for the default. */
const environmentParams = (environment: string): Record<string, string> =>
  environment === DEFAULT_ENVIRONMENT ? {} : { environment };

export const analyticsQuery = (
  projectId: string,
  range: PageRange,
  filters: Filters = {},
  environment = DEFAULT_ENVIRONMENT,
) =>
  queryOptions({
    queryKey: ["analytics", projectId, range, filters, environment],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...environmentParams(environment),
        ...Object.fromEntries(activeFilters(filters)),
      });
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

/** Every list of the analytics page; each can be read in full with listQuery. */
export type ListReport = "pages" | "customEvents" | Breakdown;

/** Rows a list shows on the page; a list this long may have more ("Show all"). */
export const LIST_PREVIEW_ROWS = 10;
/** Rows one page of a full list holds. */
export const LIST_PAGE_SIZE = 50;

/** A row of any list, in one shape: its name, visitors, and the second number (views, visits, or events). */
export interface ListRow {
  /** null: unknown. */
  name: string | null;
  visitors: number;
  second: number;
}

export interface ListPage {
  rows: ListRow[];
  hasMore: boolean;
}

const hasMore = (value: Record<string, unknown>) => typeof value.hasMore === "boolean";

/** The API's rows for `report`, in the shape every list uses, or null when they do not match. */
function listPage(report: ListReport, value: unknown): ListPage | null {
  if (!isRecord(value) || !hasMore(value) || !Array.isArray(value.rows)) {
    return null;
  }
  const more = value.hasMore === true;
  if (report === "pages") {
    return isListOf(value.rows, isPageRow)
      ? {
          hasMore: more,
          rows: value.rows.map((row) => ({
            name: row.path,
            visitors: row.visitors,
            second: row.pageviews,
          })),
        }
      : null;
  }
  if (report === "customEvents") {
    return isListOf(value.rows, isCustomEventRow)
      ? {
          hasMore: more,
          rows: value.rows.map((row) => ({
            name: row.name,
            visitors: row.visitors,
            second: row.events,
          })),
        }
      : null;
  }
  return isListOf(value.rows, isBreakdownRow)
    ? {
        hasMore: more,
        rows: value.rows.map((row) => ({
          name: row.value,
          visitors: row.visitors,
          second: row.visits,
        })),
      }
    : null;
}

/** One list in full, LIST_PAGE_SIZE rows at a time, with the page's period, environment, and filters. */
export const listQuery = (
  projectId: string,
  range: PageRange,
  filters: Filters,
  environment: string,
  report: ListReport,
  search: string,
) =>
  infiniteQueryOptions({
    queryKey: ["analytics-list", projectId, range, filters, environment, report, search],
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...environmentParams(environment),
        ...Object.fromEntries(activeFilters(filters)),
        report,
        offset: String(pageParam),
        limit: String(LIST_PAGE_SIZE),
        ...(search === "" ? {} : { search }),
      });
      const body = await apiRequest(
        `/api/projects/${encodeURIComponent(projectId)}/analytics/list?${query.toString()}`,
        { signal },
      );
      const page = listPage(report, body);
      if (page === null) {
        throw new ApiError(0, "The API sent an unexpected response.");
      }
      return page;
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.reduce((rows, page) => rows + page.rows.length, 0) : undefined,
    // While a new search loads, keep showing the last results.
    placeholderData: keepPreviousData,
  });
