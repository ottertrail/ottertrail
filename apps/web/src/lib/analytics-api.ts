import type { GoalResult } from "./goals-api";
import type { Step } from "./steps";

/** Ranges the analytics page offers; each ends today in the timezone set in Settings. */
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
  /** With a goal: the visitors with a goal event that day. */
  converted?: number;
}

export interface PageRow {
  path: string;
  pageviews: number;
  visitors: number;
  avgEngagedMs: number | null;
  /** With a goal: the visitors who viewed the page in a visit that reached it. */
  converted?: number;
}

export interface BreakdownRow {
  /** null: unknown (no referrer host, no location, an unrecognized browser …). */
  value: string | null;
  visitors: number;
  visits: number;
  bounceRate: number | null;
  /** With a goal: the visitors with a visit of this value that reached it. */
  converted?: number;
}

export interface CustomEventRow {
  name: string;
  events: number;
  visitors: number;
}

/** An outbound link's or a file's origin and path, or a not found page's path. */
export interface EventValueRow {
  value: string;
  visitors: number;
  events: number;
  /** With a goal: the visitors who did it in a visit that reached it. */
  converted?: number;
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
  outboundLinks: EventValueRow[];
  fileDownloads: EventValueRow[];
  notFoundPages: EventValueRow[];
  /** The project's saved goals, in the order added, counted in the same visits. */
  goals: GoalResult[];
  /** The goal the page is filtered by, with its counts; null without one. */
  goal: PageGoalResult | null;
  previous: PreviousPeriod;
}

/** A saved goal (`id`) or a custom event by name (`id` null), with its conversions. */
export interface PageGoalResult {
  id: string | null;
  name: string;
  step: Step;
  /** Daily visitor IDs that reached it. */
  converted: number;
  events: number;
  /** converted / the summary's visitors: 0 to 1. */
  conversionRate: number;
  previous: { converted: number; events: number };
}

/** Every list of the analytics page; each can be read in full (analytics-queries.ts). */
export type ListReport = "pages" | "customEvents" | Breakdown | EventList;

/** The lists of the tracker's link and not found events. */
export type EventList = "outboundLinks" | "fileDownloads" | "notFoundPages";

/**
 * "page" matches visits that viewed that page; "outbound", "download", and
 * "notFound" visits with that link clicked or that not found page. Other
 * filters match exact property values.
 */
export const FILTER_NAMES = [
  "page",
  "outbound",
  "download",
  "notFound",
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
] as const satisfies readonly ("page" | "outbound" | "download" | "notFound" | Breakdown)[];

export type FilterName = (typeof FILTER_NAMES)[number];

/** Active filters by name. An empty string matches visits where the value is unknown. */
export type Filters = { [Name in FilterName]?: string | undefined };

export const FILTER_LABELS: Record<FilterName, string> = {
  page: "Page",
  outbound: "Outbound link",
  download: "File download",
  notFound: "Not found page",
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
 * Include every filter name, with undefined for invalid or absent values.
 * The router merges this over the raw query; omitted names would keep unchecked values.
 */
export function filtersFrom(
  search: Record<string, unknown>,
): Record<FilterName, string | undefined> {
  return {
    page: filterValue(search.page),
    outbound: filterValue(search.outbound),
    download: filterValue(search.download),
    notFound: filterValue(search.notFound),
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

export function activeFilters(filters: Filters): [FilterName, string][] {
  return FILTER_NAMES.flatMap((name) => {
    const value = filters[name];
    return value === undefined ? [] : [[name, value] as [FilterName, string]];
  });
}
