import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import {
  type Analytics,
  appendFilters,
  BREAKDOWNS,
  type BreakdownRow,
  type CustomEventRow,
  type ChartCounts,
  type ChartPoint,
  type ChartView,
  chartViewParams,
  isChartInterval,
  isComparison,
  DEFAULT_COMPARISON,
  DEFAULT_ENVIRONMENT,
  type EventList,
  type EventValueRow,
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
import { isReportGoal } from "./goals-api";
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

const isChartCounts = (value: unknown): value is ChartCounts =>
  isRecord(value) &&
  isNumber(value.visitors) &&
  isNumber(value.pageviews) &&
  isNumber(value.visits) &&
  hasConverted(value);

const isChartPoint = (value: unknown): value is ChartPoint =>
  isChartCounts(value) &&
  isRecord(value) &&
  typeof value.start === "string" &&
  typeof value.end === "string" &&
  typeof value.partial === "boolean" &&
  (value.previous === null || isChartCounts(value.previous));

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
  hasConverted(value) &&
  (value.exitRate === undefined || isNumberOrNull(value.exitRate));

const isCustomEventRow = (value: unknown): value is CustomEventRow =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isNumber(value.events) &&
  isNumber(value.visitors);

const isEventValueRow = (value: unknown): value is EventValueRow =>
  isRecord(value) &&
  typeof value.value === "string" &&
  isNumber(value.visitors) &&
  isNumber(value.events) &&
  hasConverted(value);

export const EVENT_LISTS: readonly EventList[] = [
  "outboundLinks",
  "fileDownloads",
  "notFoundPages",
];

const isEventList = (report: ListReport): report is EventList =>
  EVENT_LISTS.some((list) => list === report);

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
  (value.step === undefined || isStep(value.step)) &&
  isNumber(value.converted) &&
  isNumber(value.events) &&
  isNumber(value.conversionRate) &&
  (value.previous === null ||
    (isRecord(value.previous) &&
      isNumber(value.previous.converted) &&
      isNumber(value.previous.events)));

export const isAnalytics = (value: unknown): value is Analytics =>
  isRecord(value) &&
  typeof value.timeZone === "string" &&
  typeof value.environment === "string" &&
  isListOf(value.environments, (item): item is string => typeof item === "string") &&
  typeof value.firstDay === "string" &&
  typeof value.lastDay === "string" &&
  isSummary(value.summary) &&
  typeof value.from === "string" &&
  typeof value.to === "string" &&
  isChartInterval(value.interval) &&
  isListOf(value.intervals, isChartInterval) &&
  isComparison(value.comparison) &&
  isListOf(value.chart, isChartPoint) &&
  isListOf(value.pages, isPageRow) &&
  isListOf(value.customEvents, isCustomEventRow) &&
  EVENT_LISTS.every((list) => isListOf(value[list], isEventValueRow)) &&
  isListOf(value.goals, isReportGoal) &&
  (value.goal === null || isPageGoal(value.goal)) &&
  (value.previous === null || isPreviousPeriod(value.previous)) &&
  isRecord(value.breakdowns) &&
  BREAKDOWNS.every((name) =>
    isListOf(isRecord(value.breakdowns) ? value.breakdowns[name] : undefined, isBreakdownRow),
  );

/** The goal the page is filtered by: a saved goal's ID, or a custom event by name. */
export type GoalChoice = { id: string } | { event: string };

/** The tracker's own events: never a goal (product events only). */
export const TRACKER_EVENTS: readonly string[] = [
  "pageview",
  "engagement",
  "error",
  "vitals",
  "not_found",
];

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

/**
 * Where the Web analytics reports are read: a project's routes, for the
 * signed-in dashboard, or a shared link's (docs/web-analytics.md, "Shared
 * links"). `key` names it in the query cache: the project's ID, as every
 * project query starts, or the link's.
 */
export interface ReportSource {
  key: string;
  /** The routes' common path, such as `/api/projects/<id>`. */
  path: string;
  /** A shared link's routes take no environment: the link names its own. */
  shared: boolean;
}

export const projectReports = (projectId: string): ReportSource => ({
  key: projectId,
  path: `/api/projects/${encodeURIComponent(projectId)}`,
  shared: false,
});

export const sharedReports = (token: string): ReportSource => ({
  key: `share:${token}`,
  path: `/api/share/${encodeURIComponent(token)}`,
  shared: true,
});

/** How often a page that shows today refreshes on its own. */
const REFRESH_MS = 60_000;

export const environmentParams = (
  source: ReportSource,
  environment: string,
): Record<string, string> =>
  environment === DEFAULT_ENVIRONMENT || source.shared ? {} : { environment };

export const analyticsQuery = (
  source: ReportSource,
  range: PageRange<string>,
  filters: Filters = [],
  environment = DEFAULT_ENVIRONMENT,
  goal?: GoalChoice,
  view: ChartView = { comparison: DEFAULT_COMPARISON },
) =>
  queryOptions({
    queryKey: [
      "analytics",
      source.key,
      range,
      filters,
      environment,
      goalParams(goal),
      chartViewParams(view),
    ],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...environmentParams(source, environment),
        ...goalParams(goal),
        ...chartViewParams(view),
      });
      appendFilters(query, filters);
      return expectShape(
        await apiRequest(`${source.path}/analytics?${query.toString()}`, { signal }),
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
  /** Exit pages only: exits divided by pageviews. */
  exitRate?: number | null | undefined;
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
  if (isEventList(report)) {
    return isListOf(value.rows, isEventValueRow)
      ? {
          hasMore: more,
          rows: value.rows.map((row) => ({
            name: row.value,
            visitors: row.visitors,
            second: row.events,
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
          exitRate: row.exitRate,
        })),
      }
    : null;
}

/**
 * A list's first LIST_PREVIEW_ROWS rows, as a card shows them, for a list
 * the page's answer does not hold: a tab's, read when the tab shows. The
 * cache keeps it per range, filters, environment, and goal, so switching
 * back to the tab shows it at once.
 */
export const listPreviewQuery = (
  source: ReportSource,
  range: PageRange<string>,
  filters: Filters,
  environment: string,
  report: ListReport,
  goal?: GoalChoice,
) =>
  queryOptions({
    queryKey: [
      "analytics-list-preview",
      source.key,
      range,
      filters,
      environment,
      report,
      goalParams(goal),
    ],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...environmentParams(source, environment),
        ...goalParams(goal),
        report,
        limit: String(LIST_PREVIEW_ROWS),
      });
      appendFilters(query, filters);
      const body = await apiRequest(`${source.path}/analytics/list?${query.toString()}`, {
        signal,
      });
      const page = listPage(report, body);
      if (page === null) {
        throw new ApiError(0, "The API sent an unexpected response.");
      }
      return page.rows;
    },
    // While another period or filter loads, keep this list's rows; never another tab's.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[5] === report ? previous : undefined,
    refetchInterval: REFRESH_MS,
  });

/** One list in full, LIST_PAGE_SIZE rows at a time, with the page's period, environment, filters, and goal. */
export const listQuery = (
  source: ReportSource,
  range: PageRange<string>,
  filters: Filters,
  environment: string,
  report: ListReport,
  search: string,
  goal?: GoalChoice,
) =>
  infiniteQueryOptions({
    queryKey: [
      "analytics-list",
      source.key,
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
        ...environmentParams(source, environment),
        ...goalParams(goal),
        report,
        offset: String(pageParam),
        limit: String(LIST_PAGE_SIZE),
        ...(search === "" ? {} : { search }),
      });
      appendFilters(query, filters);
      const body = await apiRequest(`${source.path}/analytics/list?${query.toString()}`, {
        signal,
      });
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
