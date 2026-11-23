import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";

/**
 * Product analytics (docs/product-analytics.md): the events a site sends
 * itself, an ordered funnel, and weekly retention of signed-in users.
 */

/** One product event's counts in the range. */
export interface ProductEventRow {
  name: string;
  events: number;
  /** Daily visitor IDs; a server's events have none. */
  visitors: number;
  /** Signed-in users. */
  users: number;
}

/** What every answer says about its range. */
interface Answered {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
}

/** GET /api/projects/:id/events: most frequent first, the top 100. */
export interface ProductEvents extends Answered {
  environments: string[];
  events: ProductEventRow[];
}

/** One property equal to one value, compared as text. */
export interface PropertyFilter {
  key: string;
  value: string;
}

/** Filters per request, as the API allows. */
export const MAX_FILTERS = 5;

export interface PropertyBreakdown {
  key: string;
  /** Events with this property. */
  events: number;
  /** Its most frequent values (up to 10), as text. */
  values: { value: string; events: number }[];
}

/** GET /api/projects/:id/events/:name: zeros, never 404, when nothing matches. */
export interface ProductEventDetail extends Answered, ProductEventRow {
  filters: PropertyFilter[];
  /** Every day of the range. */
  days: { day: string; events: number }[];
  /** The 30 most frequent keys. */
  properties: PropertyBreakdown[];
}

export type FunnelStep =
  | { type: "event"; name: string; filter?: PropertyFilter }
  | { type: "page"; path: string };

export const MIN_STEPS = 2;
export const MAX_STEPS = 5;

/** Who a funnel follows: a daily visitor ID, or a signed-in user's ID. */
export const FUNNEL_COUNTS = [
  { value: "visitors", label: "Visitors" },
  { value: "users", label: "Users" },
] as const;
export type FunnelCount = (typeof FUNNEL_COUNTS)[number]["value"];
export const DEFAULT_FUNNEL_COUNT: FunnelCount = "visitors";

export const isFunnelCount = (value: unknown): value is FunnelCount =>
  FUNNEL_COUNTS.some((item) => item.value === value);

/** Conversion windows the API allows, in seconds. */
export const FUNNEL_WINDOWS = [
  { value: 300, label: "5 minutes" },
  { value: 1800, label: "30 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 86_400, label: "1 day" },
  { value: 604_800, label: "7 days" },
  { value: 1_209_600, label: "14 days" },
  { value: 2_592_000, label: "30 days" },
] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number]["value"];

/** The API's default, and the longest a visitor can be followed: visitor IDs change daily. */
export const DEFAULT_FUNNEL_WINDOW: FunnelWindow = 86_400;
export const MAX_VISITOR_WINDOW: FunnelWindow = 86_400;

export const isFunnelWindow = (value: unknown): value is FunnelWindow =>
  FUNNEL_WINDOWS.some((item) => item.value === value);

export const windowAllowed = (count: FunnelCount, window: FunnelWindow) =>
  count === "users" || window <= MAX_VISITOR_WINDOW;

/** GET /api/projects/:id/funnel */
export interface Funnel extends Answered {
  /** The environments with pageviews or product events, for the picker. */
  environments: string[];
  count: FunnelCount;
  window: number;
  steps: { step: FunnelStep; reached: number }[];
}

export interface Cohort {
  /** The Monday the cohort's week starts. */
  week: string;
  /** Users first seen that week. */
  users: number;
  /** Users who did something in week 0, 1, 2 … after; week 0 is everyone. */
  retained: number[];
}

/** GET /api/projects/:id/retention */
export interface Retention extends Answered {
  /** The environments with signed-in users' events, for the picker. */
  environments: string[];
  /** The Monday of the current week, which is not over. */
  currentWeek: string;
  cohorts: Cohort[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);

const isAnswered = (value: Record<string, unknown>) =>
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.firstDay) &&
  isText(value.lastDay);

const isEventRow = (value: unknown): value is ProductEventRow =>
  isRecord(value) &&
  isText(value.name) &&
  isNumber(value.events) &&
  isNumber(value.visitors) &&
  isNumber(value.users);

const isProductEvents = (value: unknown): value is ProductEvents =>
  isRecord(value) &&
  isAnswered(value) &&
  isListOf(value.environments, isText) &&
  isListOf(value.events, isEventRow);

const isFilter = (value: unknown): value is PropertyFilter =>
  isRecord(value) && isText(value.key) && isText(value.value);

const isValueRow = (value: unknown): value is PropertyBreakdown["values"][number] =>
  isRecord(value) && isText(value.value) && isNumber(value.events);

const isBreakdown = (value: unknown): value is PropertyBreakdown =>
  isRecord(value) &&
  isText(value.key) &&
  isNumber(value.events) &&
  isListOf(value.values, isValueRow);

const isDay = (value: unknown): value is ProductEventDetail["days"][number] =>
  isRecord(value) && isText(value.day) && isNumber(value.events);

const isEventDetail = (value: unknown): value is ProductEventDetail =>
  isRecord(value) &&
  isAnswered(value) &&
  isEventRow(value) &&
  isListOf(value.filters, isFilter) &&
  isListOf(value.days, isDay) &&
  isListOf(value.properties, isBreakdown);

export const isFunnelStep = (value: unknown): value is FunnelStep =>
  isRecord(value) &&
  ((value.type === "page" && isText(value.path)) ||
    (value.type === "event" &&
      isText(value.name) &&
      (value.filter === undefined || isFilter(value.filter))));

const isFunnel = (value: unknown): value is Funnel =>
  isRecord(value) &&
  isAnswered(value) &&
  isListOf(value.environments, isText) &&
  isFunnelCount(value.count) &&
  isNumber(value.window) &&
  isListOf(
    value.steps,
    (item): item is Funnel["steps"][number] =>
      isRecord(item) && isFunnelStep(item.step) && isNumber(item.reached),
  );

const isCohort = (value: unknown): value is Cohort =>
  isRecord(value) &&
  isText(value.week) &&
  isNumber(value.users) &&
  isListOf(value.retained, isNumber);

const isRetention = (value: unknown): value is Retention =>
  isRecord(value) &&
  isAnswered(value) &&
  isListOf(value.environments, isText) &&
  isText(value.currentWeek) &&
  isListOf(value.cohorts, isCohort);

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

const rangeQuery = (range: PageRange, environment: string): Record<string, string> => ({
  ...rangeParams(range),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
});

async function get<T>(
  path: string,
  query: URLSearchParams,
  signal: AbortSignal,
  isShape: (value: unknown) => value is T,
): Promise<T> {
  return expectShape(await apiRequest(`${path}?${query.toString()}`, { signal }), isShape);
}

/** The project's product events in a range and an environment, most frequent first. */
export const productEventsQuery = (projectId: string, range: PageRange, environment: string) =>
  queryOptions({
    queryKey: ["product-events", projectId, range, environment],
    queryFn: ({ signal }) =>
      get(
        `${projectPath(projectId)}/events`,
        new URLSearchParams(rangeQuery(range, environment)),
        signal,
        isProductEvents,
      ),
    // While another period loads, keep showing this one (dimmed).
    placeholderData: keepPreviousData,
  });

export const productEventQuery = (
  projectId: string,
  name: string,
  range: PageRange,
  environment: string,
  filters: readonly PropertyFilter[],
) =>
  queryOptions({
    queryKey: ["product-event", projectId, name, range, environment, filters],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams(rangeQuery(range, environment));
      for (const filter of filters) {
        query.append(`p.${filter.key}`, filter.value);
      }
      return get(
        `${projectPath(projectId)}/events/${encodeURIComponent(name)}`,
        query,
        signal,
        isEventDetail,
      );
    },
    placeholderData: keepPreviousData,
  });

/** An ordered funnel of 2 to 5 complete steps. */
export const funnelQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  window: FunnelWindow,
) =>
  queryOptions({
    queryKey: ["funnel", projectId, range, environment, steps, count, window],
    queryFn: ({ signal }) =>
      get(
        `${projectPath(projectId)}/funnel`,
        new URLSearchParams({
          ...rangeQuery(range, environment),
          steps: JSON.stringify(steps),
          count,
          window: String(window),
        }),
        signal,
        isFunnel,
      ),
    placeholderData: keepPreviousData,
  });

/** Weekly cohorts of signed-in users whose first week falls in the range. */
export const retentionQuery = (projectId: string, range: PageRange, environment: string) =>
  queryOptions({
    queryKey: ["retention", projectId, range, environment],
    queryFn: ({ signal }) =>
      get(
        `${projectPath(projectId)}/retention`,
        new URLSearchParams(rangeQuery(range, environment)),
        signal,
        isRetention,
      ),
    placeholderData: keepPreviousData,
  });
