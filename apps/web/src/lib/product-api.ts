import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isStep, type Step } from "./steps";

/**
 * Product analytics (docs/product-analytics.md): the events a site sends
 * itself, an ordered funnel, and weekly retention of signed-in users.
 */

export interface ProductEventCounts {
  events: number;
  /** Daily visitor IDs; a server's events have none. */
  visitors: number;
  /** Signed-in users. */
  users: number;
}

/** One product event's counts in the range, and in the period before. */
export interface ProductEventRow extends ProductEventCounts {
  name: string;
  previous: ProductEventCounts;
}

/**
 * The period before, of the same length (apps/api/src/reports/reports.ts,
 * previousDays): its days, and while the period runs, the moment it is
 * compared up to; null otherwise.
 */
export interface PeriodBefore {
  firstDay: string;
  lastDay: string;
  until: string | null;
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
  previous: PeriodBefore;
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
  previous: PeriodBefore & ProductEventCounts;
  filters: PropertyFilter[];
  /** Every day of the range. */
  days: { day: string; events: number }[];
  /** The 30 most frequent keys. */
  properties: PropertyBreakdown[];
}

export type FunnelStep = Step;

export const MIN_STEPS = 2;
export const MAX_STEPS = 8;

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

/**
 * The period before, of the same length (apps/api/src/reports/reports.ts,
 * previousDays): its days, its cut-off while the period runs, and the
 * people who reached each step.
 */
export interface FunnelPrevious {
  firstDay: string;
  lastDay: string;
  /** While the period runs: the moment it is compared up to; null otherwise. */
  until: string | null;
  reached: number[];
}

/** GET /api/projects/:id/funnel */
export interface Funnel extends Answered {
  /** The environments with pageviews or product events, for the picker. */
  environments: string[];
  count: FunnelCount;
  window: number;
  steps: { step: FunnelStep; reached: number }[];
  /** Left out only while the saved funnels list's counts stand in for the answer. */
  previous?: FunnelPrevious;
}

/**
 * What a funnel can be broken down by (apps/api/src/product/funnel.ts,
 * BREAKDOWN_NAMES), named as the Web analytics page names them: step 1's
 * visit's source and campaign, or a column of its event; or "p.<key>", a
 * property of step 1's event.
 */
export const BREAKDOWN_COLUMNS = [
  { value: "source", label: "Source" },
  { value: "utmCampaign", label: "Campaign" },
  { value: "deviceType", label: "Device" },
  { value: "browser", label: "Browser" },
  { value: "os", label: "Operating system" },
  { value: "country", label: "Country" },
  { value: "release", label: "Release" },
] as const;
export type BreakdownColumn = (typeof BREAKDOWN_COLUMNS)[number]["value"];
/** A column, or "p.<key>". */
export type FunnelBreakdownBy = BreakdownColumn | `p.${string}`;

export const BREAKDOWN_PROPERTY_PREFIX = "p.";
/** As the API checks a property name: 1 to 100 characters, no NUL. */
// eslint-disable-next-line no-control-regex -- NUL is what it refuses
const PROPERTY_KEY = /^[^\u0000]{1,100}$/u;

export const isBreakdownBy = (value: unknown): value is FunnelBreakdownBy =>
  typeof value === "string" &&
  (BREAKDOWN_COLUMNS.some((item) => item.value === value) ||
    (value.startsWith(BREAKDOWN_PROPERTY_PREFIX) &&
      PROPERTY_KEY.test(value.slice(BREAKDOWN_PROPERTY_PREFIX.length))));

/** One row of a breakdown: a value, the rest of the values, or no value. */
export interface FunnelBreakdownRow {
  kind: "value" | "other" | "unknown";
  /** The value, for kind "value"; null otherwise. */
  value: string | null;
  /** People at each step. */
  reached: number[];
}

/** GET /api/projects/:id/funnel/breakdown: the top 5 values by step 1, then Other, then Unknown. */
export interface FunnelBreakdown extends Answered {
  count: FunnelCount;
  window: number;
  by: string;
  rows: FunnelBreakdownRow[];
}

/** Whom a list of people holds: those who stopped after a step, or reached the last. */
export type PeopleOutcome = "dropped" | "converted";

/** GET /api/projects/:id/funnel/people: up to `limit` users, most recent first, and the total. */
export interface FunnelPeople extends Answered {
  step: number;
  outcome: PeopleOutcome;
  limit: number;
  total: number;
  users: { userId: string; reachedAt: string }[];
}

/** One day (or the Monday of one week) of a funnel's conversion over time. */
export interface FunnelTrendPoint {
  day: string;
  /** People whose first step 1 in the period was that day or week. */
  started: number;
  /** Of them, those who reached the last step. */
  converted: number;
}

/** GET /api/projects/:id/funnel/trend: days with nobody at step 1 are left out. */
export interface FunnelTrend extends Answered {
  count: FunnelCount;
  window: number;
  unit: "day" | "week";
  points: FunnelTrendPoint[];
}

/** The time between two steps, in seconds, for those who reached the later one. */
export interface FunnelStepTime {
  people: number;
  median: number | null;
  p75: number | null;
}

/** GET /api/projects/:id/funnel/times: `between[0]` is step 1 to step 2. */
export interface FunnelTimes extends Answered {
  count: FunnelCount;
  window: number;
  between: FunnelStepTime[];
  overall: FunnelStepTime;
}

/** One saved funnel's counts, in GET /api/projects/:id/funnels/results. */
export interface SavedFunnelResult {
  id: string;
  count: FunnelCount;
  window: number;
  steps: { step: FunnelStep; reached: number }[];
}

/** GET /api/projects/:id/funnels/results: every saved funnel's counts, by name. */
export interface SavedFunnelResults extends Answered {
  funnels: SavedFunnelResult[];
}

export interface Cohort {
  /** The Monday the cohort's week starts. */
  week: string;
  /** Users first seen that week. */
  users: number;
  /** Users who did something in week 0, 1, 2 … after; week 0 is everyone. */
  retained: number[];
}

/** Sums over the cohorts whose week at this offset is over. */
export interface WeekAverage {
  users: number;
  retained: number;
}

/** GET /api/projects/:id/retention */
export interface Retention extends Answered {
  /** The environments with signed-in users' events, for the picker. */
  environments: string[];
  /** The Monday of the current week, which is not over. */
  currentWeek: string;
  /** Every cohort whose first week holds a day of the range, oldest first. */
  cohorts: Cohort[];
  /** One per week offset, pooled over the cohorts that finished it. */
  average: WeekAverage[];
  /** Whether any of the project's events carries a user ID. */
  identifiesUsers: boolean;
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

const isCounts = (value: unknown): value is ProductEventCounts =>
  isRecord(value) && isNumber(value.events) && isNumber(value.visitors) && isNumber(value.users);

const isEventRow = (value: unknown): value is ProductEventRow =>
  isRecord(value) && isText(value.name) && isCounts(value.previous) && isCounts(value);

const isPeriodBefore = (value: unknown): value is PeriodBefore =>
  isRecord(value) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  (value.until === null || isText(value.until));

const isProductEvents = (value: unknown): value is ProductEvents =>
  isRecord(value) &&
  isAnswered(value) &&
  isListOf(value.environments, isText) &&
  isPeriodBefore(value.previous) &&
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
  isPeriodBefore(value.previous) &&
  isListOf(value.filters, isFilter) &&
  isListOf(value.days, isDay) &&
  isListOf(value.properties, isBreakdown);

export const isFunnelStep: (value: unknown) => value is FunnelStep = isStep;

const isStepResult = (item: unknown): item is Funnel["steps"][number] =>
  isRecord(item) && isFunnelStep(item.step) && isNumber(item.reached);

const isPrevious = (value: unknown): value is FunnelPrevious =>
  isRecord(value) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  (value.until === null || isText(value.until)) &&
  isListOf(value.reached, isNumber);

const isFunnel = (value: unknown): value is Funnel =>
  isRecord(value) &&
  isAnswered(value) &&
  isListOf(value.environments, isText) &&
  isFunnelCount(value.count) &&
  isNumber(value.window) &&
  isListOf(value.steps, isStepResult) &&
  isPrevious(value.previous);

const isBreakdownRow = (value: unknown): value is FunnelBreakdownRow =>
  isRecord(value) &&
  (value.kind === "value" || value.kind === "other" || value.kind === "unknown") &&
  (value.value === null || isText(value.value)) &&
  isListOf(value.reached, isNumber);

const isFunnelBreakdown = (value: unknown): value is FunnelBreakdown =>
  isRecord(value) &&
  isAnswered(value) &&
  isFunnelCount(value.count) &&
  isNumber(value.window) &&
  isText(value.by) &&
  isListOf(value.rows, isBreakdownRow);

const isPerson = (value: unknown): value is FunnelPeople["users"][number] =>
  isRecord(value) && isText(value.userId) && isText(value.reachedAt);

const isFunnelPeople = (value: unknown): value is FunnelPeople =>
  isRecord(value) &&
  isAnswered(value) &&
  isNumber(value.step) &&
  (value.outcome === "dropped" || value.outcome === "converted") &&
  isNumber(value.limit) &&
  isNumber(value.total) &&
  isListOf(value.users, isPerson);

const isTrendPoint = (value: unknown): value is FunnelTrendPoint =>
  isRecord(value) && isText(value.day) && isNumber(value.started) && isNumber(value.converted);

const isFunnelTrend = (value: unknown): value is FunnelTrend =>
  isRecord(value) &&
  isAnswered(value) &&
  isFunnelCount(value.count) &&
  isNumber(value.window) &&
  (value.unit === "day" || value.unit === "week") &&
  isListOf(value.points, isTrendPoint);

const isSeconds = (value: unknown): value is number | null => value === null || isNumber(value);

const isStepTime = (value: unknown): value is FunnelStepTime =>
  isRecord(value) && isNumber(value.people) && isSeconds(value.median) && isSeconds(value.p75);

const isFunnelTimes = (value: unknown): value is FunnelTimes =>
  isRecord(value) &&
  isAnswered(value) &&
  isFunnelCount(value.count) &&
  isNumber(value.window) &&
  isListOf(value.between, isStepTime) &&
  isStepTime(value.overall);

const isSavedFunnelResult = (value: unknown): value is SavedFunnelResult =>
  isRecord(value) &&
  isText(value.id) &&
  isFunnelCount(value.count) &&
  isNumber(value.window) &&
  isListOf(value.steps, isStepResult);

const isSavedFunnelResults = (value: unknown): value is SavedFunnelResults =>
  isRecord(value) && isAnswered(value) && isListOf(value.funnels, isSavedFunnelResult);

const isCohort = (value: unknown): value is Cohort =>
  isRecord(value) &&
  isText(value.week) &&
  isNumber(value.users) &&
  isListOf(value.retained, isNumber);

const isWeekAverage = (value: unknown): value is WeekAverage =>
  isRecord(value) && isNumber(value.users) && isNumber(value.retained);

const isRetention = (value: unknown): value is Retention =>
  isRecord(value) &&
  isAnswered(value) &&
  isListOf(value.environments, isText) &&
  isText(value.currentWeek) &&
  isListOf(value.cohorts, isCohort) &&
  isListOf(value.average, isWeekAverage) &&
  typeof value.identifiesUsers === "boolean";

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

/**
 * The project's product events in a range and an environment, most frequent
 * first; with `search`, those whose name contains it, in any case.
 */
export const productEventsQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  search = "",
) =>
  queryOptions({
    queryKey: ["product-events", projectId, range, environment, search],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams(rangeQuery(range, environment));
      if (search !== "") query.set("search", search);
      return get(`${projectPath(projectId)}/events`, query, signal, isProductEvents);
    },
    // While another period loads, keep showing this one (dimmed).
    placeholderData: keepPreviousData,
  });

/** An event's page: the range, its property filters, and its dimensions' filters (`more`). */
export const productEventQuery = (
  projectId: string,
  name: string,
  range: PageRange,
  environment: string,
  filters: readonly PropertyFilter[],
  more: Record<string, string> = {},
) =>
  queryOptions({
    queryKey: ["product-event", projectId, name, range, environment, filters, more],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ ...rangeQuery(range, environment), ...more });
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

/** A funnel's query: the range, its steps as the API's JSON, who it counts, and its window. */
const funnelParams = (
  range: PageRange,
  environment: string,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  window: FunnelWindow,
) => ({
  ...rangeQuery(range, environment),
  steps: JSON.stringify(steps),
  count,
  window: String(window),
});

/** An ordered funnel of 2 to 8 complete steps. */
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
        new URLSearchParams(funnelParams(range, environment, steps, count, window)),
        signal,
        isFunnel,
      ),
    placeholderData: keepPreviousData,
  });

/** A funnel by one dimension: each person under the value on their step 1. */
export const funnelBreakdownQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  window: FunnelWindow,
  by: FunnelBreakdownBy,
) =>
  queryOptions({
    queryKey: ["funnel", projectId, range, environment, steps, count, window, "by", by],
    queryFn: ({ signal }) =>
      get(
        `${projectPath(projectId)}/funnel/breakdown`,
        new URLSearchParams({ ...funnelParams(range, environment, steps, count, window), by }),
        signal,
        isFunnelBreakdown,
      ),
    placeholderData: keepPreviousData,
  });

/** The funnel's overall conversion per day, or per week for a long period. */
export const funnelTrendQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  window: FunnelWindow,
) =>
  queryOptions({
    queryKey: ["funnel", projectId, range, environment, steps, count, window, "trend"],
    queryFn: ({ signal }) =>
      get(
        `${projectPath(projectId)}/funnel/trend`,
        new URLSearchParams(funnelParams(range, environment, steps, count, window)),
        signal,
        isFunnelTrend,
      ),
    placeholderData: keepPreviousData,
  });

/** The median and 75th percentile time from each step to the next, and overall. */
export const funnelTimesQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  window: FunnelWindow,
) =>
  queryOptions({
    queryKey: ["funnel", projectId, range, environment, steps, count, window, "times"],
    queryFn: ({ signal }) =>
      get(
        `${projectPath(projectId)}/funnel/times`,
        new URLSearchParams(funnelParams(range, environment, steps, count, window)),
        signal,
        isFunnelTimes,
      ),
    placeholderData: keepPreviousData,
  });

/** The signed-in users who stopped after `step` (from 1), or converted at the last. */
export const funnelPeopleQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  steps: readonly FunnelStep[],
  window: FunnelWindow,
  step: number,
  outcome: PeopleOutcome,
) =>
  queryOptions({
    queryKey: ["funnel", projectId, range, environment, steps, "users", window, "people", step],
    queryFn: ({ signal }) =>
      get(
        `${projectPath(projectId)}/funnel/people`,
        new URLSearchParams({
          ...funnelParams(range, environment, steps, "users", window),
          step: String(step),
          outcome,
        }),
        signal,
        isFunnelPeople,
      ),
  });

/**
 * Every saved funnel's counts in a range and an environment, in one request.
 * The key starts with the saved funnels' own (funnels-api.ts, savedFunnelsKey),
 * so saving, changing, or deleting a funnel refreshes it too.
 */
export const savedFunnelResultsQuery = (projectId: string, range: PageRange, environment: string) =>
  queryOptions({
    queryKey: ["saved-funnels", projectId, "results", range, environment],
    queryFn: ({ signal }) =>
      get(
        `${projectPath(projectId)}/funnels/results`,
        new URLSearchParams(rangeQuery(range, environment)),
        signal,
        isSavedFunnelResults,
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
