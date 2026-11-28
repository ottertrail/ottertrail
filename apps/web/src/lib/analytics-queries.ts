import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import {
  activeFilters,
  type Analytics,
  BREAKDOWNS,
  type BreakdownRow,
  type CustomEventRow,
  type DayPoint,
  DEFAULT_ENVIRONMENT,
  type Filters,
  type ListReport,
  type PageGoalResult,
  type PageRange,
  type PageRow,
  type PreviousPeriod,
  rangeParams,
  type Summary,
} from "./analytics-api";
import { ApiError, apiRequest, expectShape } from "./api";
import { isGoalResult } from "./goals-api";
import { isStep } from "./steps";

/*
 * The Analytics page's requests and the checks of their answers. Apart from
 * analytics-api.ts, which the router needs on a first visit, so they load
 * with the page.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number";
const isNumberOrNull = (value: unknown) => value === null || isNumber(value);
const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);
/** `converted` comes only with a goal. */
const hasConverted = (value: Record<string, unknown>) =>
  value.converted === undefined || isNumber(value.converted);

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
  isNumber(value.visits) &&
  hasConverted(value);

const isPageRow = (value: unknown): value is PageRow =>
  isRecord(value) &&
  typeof value.path === "string" &&
  isNumber(value.pageviews) &&
  isNumber(value.visitors) &&
  isNumberOrNull(value.avgEngagedMs) &&
  hasConverted(value);

const isBreakdownRow = (value: unknown): value is BreakdownRow =>
  isRecord(value) &&
  (value.value === null || typeof value.value === "string") &&
  isNumber(value.visitors) &&
  isNumber(value.visits) &&
  isNumberOrNull(value.bounceRate) &&
  hasConverted(value);

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

const isPageGoal = (value: unknown): value is PageGoalResult =>
  isRecord(value) &&
  (value.id === null || typeof value.id === "string") &&
  typeof value.name === "string" &&
  isStep(value.step) &&
  isNumber(value.converted) &&
  isNumber(value.events) &&
  isNumber(value.conversionRate) &&
  isRecord(value.previous) &&
  isNumber(value.previous.converted) &&
  isNumber(value.previous.events);

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
  isListOf(value.goals, isGoalResult) &&
  (value.goal === null || isPageGoal(value.goal)) &&
  isPreviousPeriod(value.previous) &&
  isRecord(value.breakdowns) &&
  BREAKDOWNS.every((name) =>
    isListOf(isRecord(value.breakdowns) ? value.breakdowns[name] : undefined, isBreakdownRow),
  );

/** The goal the page is filtered by: a saved goal's ID, or a custom event by name. */
export type GoalChoice = { id: string } | { event: string };

/** The tracker's own events: never a goal (product events only). */
export const TRACKER_EVENTS: readonly string[] = ["pageview", "engagement", "error", "vitals"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** As collection allows a name: 1 to 200 characters, no control characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const EVENT_NAME = /^[^\u0000-\u001F\u007F]{1,200}$/u;

/** Whether a custom event can be the goal, as the API checks it. */
export const canBeGoal = (name: string) => EVENT_NAME.test(name) && !TRACKER_EVENTS.includes(name);

/** The goal in an address, or none: a saved goal wins over an event, as the API takes one. */
export function goalChoiceFrom({
  goal,
  goalEvent,
}: {
  goal?: string | undefined;
  goalEvent?: string | undefined;
}): GoalChoice | undefined {
  if (goal !== undefined && UUID.test(goal)) return { id: goal.toLowerCase() };
  if (goalEvent !== undefined && canBeGoal(goalEvent)) return { event: goalEvent };
  return undefined;
}

/** The address's and the API's parameters for a goal: `goal` or `goalEvent`. */
export const goalParams = (goal: GoalChoice | undefined): Record<string, string> =>
  goal === undefined ? {} : "id" in goal ? { goal: goal.id } : { goalEvent: goal.event };

export const sameGoal = (a: GoalChoice | undefined, b: GoalChoice | undefined) =>
  JSON.stringify(goalParams(a)) === JSON.stringify(goalParams(b));

/** How often a page that shows today refreshes on its own. */
const REFRESH_MS = 60_000;

const environmentParams = (environment: string): Record<string, string> =>
  environment === DEFAULT_ENVIRONMENT ? {} : { environment };

export const analyticsQuery = (
  projectId: string,
  range: PageRange,
  filters: Filters = {},
  environment = DEFAULT_ENVIRONMENT,
  goal?: GoalChoice,
) =>
  queryOptions({
    queryKey: ["analytics", projectId, range, filters, environment, goalParams(goal)],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...environmentParams(environment),
        ...Object.fromEntries(activeFilters(filters)),
        ...goalParams(goal),
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

/** Rows a list shows on the page; a list this long may have more ("Show all"). */
export const LIST_PREVIEW_ROWS = 10;
/** Rows one page of a full list holds. */
export const LIST_PAGE_SIZE = 50;

/**
 * A row of any list, in one shape: its name, visitors, the second number
 * (views, visits, or events), and with a goal its converted visitors.
 */
export interface ListRow {
  /** null: unknown. */
  name: string | null;
  visitors: number;
  second: number;
  converted?: number | undefined;
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
            converted: row.converted,
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
          converted: row.converted,
        })),
      }
    : null;
}

/** One list in full, LIST_PAGE_SIZE rows at a time, with the page's period, environment, filters, and goal. */
export const listQuery = (
  projectId: string,
  range: PageRange,
  filters: Filters,
  environment: string,
  report: ListReport,
  search: string,
  goal?: GoalChoice,
) =>
  infiniteQueryOptions({
    queryKey: [
      "analytics-list",
      projectId,
      range,
      filters,
      environment,
      report,
      search,
      goalParams(goal),
    ],
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...environmentParams(environment),
        ...Object.fromEntries(activeFilters(filters)),
        ...goalParams(goal),
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
