import type { ReportGoal } from "./goals-api";
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
  goals: ReportGoal[];
  /** The goal the page is filtered by, with its counts; null without one. */
  goal: PageGoalResult | null;
  previous: PreviousPeriod;
}

/** A saved goal (`id`) or a custom event by name (`id` null), with its conversions. */
export interface PageGoalResult {
  id: string | null;
  name: string;
  /** What it matches; left out on a shared link. */
  step?: Step;
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
 * Free text takes every operator. A fixed value (a country, a device type, a
 * browser or system) takes is and is not only, as the API does.
 */
export type FilterKind = "text" | "fixed";

/**
 * Every filter of the Web analytics page, with its chip's label, its kind,
 * and the list whose rows set it and offer its values. Adding a filter is
 * one line here. "page" matches visits that viewed that page; "outbound",
 * "download", and "notFound" visits with that link clicked or that not
 * found page. The others match the visit's own value.
 */
export const FILTERS = {
  page: { label: "Page", kind: "text", list: "pages" },
  entryPage: { label: "Entry page", kind: "text", list: "entryPage" },
  exitPage: { label: "Exit page", kind: "text", list: "exitPage" },
  source: { label: "Source", kind: "text", list: "source" },
  utmCampaign: { label: "Campaign", kind: "text", list: "utmCampaign" },
  country: { label: "Country", kind: "fixed", list: "country" },
  region: { label: "Region", kind: "text", list: "region" },
  city: { label: "City", kind: "text", list: "city" },
  deviceType: { label: "Device", kind: "fixed", list: "deviceType" },
  browser: { label: "Browser", kind: "fixed", list: "browser" },
  os: { label: "Operating system", kind: "fixed", list: "os" },
  release: { label: "Release", kind: "text", list: "release" },
  outbound: { label: "Outbound link", kind: "text", list: "outboundLinks" },
  download: { label: "File download", kind: "text", list: "fileDownloads" },
  notFound: { label: "Not found page", kind: "text", list: "notFoundPages" },
} as const satisfies Record<string, { label: string; kind: FilterKind; list: ListReport }>;

export type FilterName = keyof typeof FILTERS;

export const isFilterName = (name: string): name is FilterName => Object.hasOwn(FILTERS, name);

export const FILTER_NAMES: readonly FilterName[] = Object.keys(FILTERS).filter(isFilterName);

/** How a filter compares a visit's value with its values. */
export const OPERATORS = ["is", "isNot", "contains", "notContains"] as const;

export type Operator = (typeof OPERATORS)[number];

export const OPERATOR_LABELS: Record<Operator, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "does not contain",
};

/** The address's and the API's parameter for each operator: `country.not=DE`. */
const OPERATOR_SUFFIXES = {
  is: "",
  isNot: ".not",
  contains: ".contains",
  notContains: ".notContains",
} as const satisfies Record<Operator, string>;

/** A filter's parameter in the address and the API's query. */
export type FilterParameter = `${FilterName}${(typeof OPERATOR_SUFFIXES)[Operator]}`;

export const operatorsOf = (name: FilterName): readonly Operator[] =>
  FILTERS[name].kind === "text" ? OPERATORS : ["is", "isNot"];

/** Contains and does not contain take typed text; is and is not a list's values. */
export const isTextOperator = (operator: Operator) =>
  operator === "contains" || operator === "notContains";

/**
 * One filter: a visit matches when its value matches any of `values` (is,
 * contains), or none of them (is not, does not contain). Filters on other
 * dimensions or operators must all match. With is and is not, "" is the
 * unknown value.
 */
export interface Filter {
  name: FilterName;
  operator: Operator;
  values: readonly string[];
}

/** The page's filters, at most one per name and operator, in FILTER_NAMES and OPERATORS order. */
export type Filters = readonly Filter[];

/** The API's limits: values per filter, and characters per value. */
export const MAX_FILTER_VALUES = 10;
export const MAX_FILTER_LENGTH = 2048;
export const MAX_CONTAINS_LENGTH = 200;

const maxLength = (operator: Operator) =>
  isTextOperator(operator) ? MAX_CONTAINS_LENGTH : MAX_FILTER_LENGTH;

/** A value the API would take for `operator`. */
export const isFilterValue = (operator: Operator, value: string) =>
  value.length <= maxLength(operator) &&
  !value.includes("\u0000") &&
  (!isTextOperator(operator) || value.trim() !== "");

/**
 * One value from the address bar's query. The router may turn "2024" into a
 * number or "true" into a boolean, so those come back as text.
 */
export function filterValue(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined;
}

const parameterOf = (name: FilterName, operator: Operator): FilterParameter =>
  `${name}${OPERATOR_SUFFIXES[operator]}`;

/** Every name and operator the address may hold, in the page's order. */
const PARAMETERS = FILTER_NAMES.flatMap((name) =>
  operatorsOf(name).map((operator) => ({ name, operator, parameter: parameterOf(name, operator) })),
);

/**
 * The filters an address asks for, in the page's order. Values the API
 * would refuse are left out, a value sent twice counts once, and values past
 * the limit are dropped, so a mangled link still shows a page.
 */
export function filtersFrom(search: Record<string, unknown>): Filter[] {
  return PARAMETERS.flatMap(({ name, operator, parameter }) => {
    const raw = search[parameter];
    const sent = (Array.isArray(raw) ? raw : [raw]).map(filterValue);
    const values = [
      ...new Set(
        sent.filter(
          (value): value is string => value !== undefined && isFilterValue(operator, value),
        ),
      ),
    ].slice(0, MAX_FILTER_VALUES);
    return values.length === 0 ? [] : [{ name, operator, values }];
  });
}

/**
 * The address's or the API's parameters for `filters`: one per name and
 * operator, repeated for each value. With `every`, the absent ones are
 * there as undefined, since the router merges a route's search over the raw
 * query and would otherwise keep unchecked values.
 */
export function filterParams(
  filters: Filters,
  { every = false }: { every?: boolean } = {},
): { [Parameter in FilterParameter]?: string[] | undefined } {
  const params: { [Parameter in FilterParameter]?: string[] | undefined } = {};
  if (every) {
    for (const { parameter } of PARAMETERS) params[parameter] = undefined;
  }
  for (const filter of filters) {
    params[parameterOf(filter.name, filter.operator)] = [...filter.values];
  }
  return params;
}

/** Appends `filters` to an API request's query. */
export function appendFilters(query: URLSearchParams, filters: Filters): URLSearchParams {
  for (const [parameter, values = []] of Object.entries(filterParams(filters))) {
    for (const value of values) query.append(parameter, value);
  }
  return query;
}

const order = (filter: Filter) =>
  FILTER_NAMES.indexOf(filter.name) * OPERATORS.length + OPERATORS.indexOf(filter.operator);

/**
 * `filters` with `filter` in its place: one per name and operator, so it
 * replaces one with the same name and operator. `replacing` names the
 * filter being edited, which goes; with no values left, nothing replaces it.
 */
export function withFilter(filters: Filters, filter: Filter, replacing?: Filter): Filter[] {
  const same = (other: Filter, item: Filter) =>
    other.name === item.name && other.operator === item.operator;
  const others = filters.filter(
    (item) => !same(item, filter) && (replacing === undefined || !same(item, replacing)),
  );
  return (filter.values.length === 0 ? others : [...others, filter]).toSorted(
    (a, b) => order(a) - order(b),
  );
}

/** `filters` without `filter`. */
export const withoutFilter = (filters: Filters, filter: Filter): Filter[] =>
  withFilter(filters, { ...filter, values: [] });
