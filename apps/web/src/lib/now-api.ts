import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { environmentParams, type ReportSource } from "./analytics-queries";
import { apiRequest, expectShape } from "./api";

/**
 * Right now: a project's visitors in the last minutes
 * (GET /api/projects/:id/analytics/now; docs/web-analytics.md, "Right now").
 * The Web analytics page's indicator, the Right now view, and the
 * Overview's widget read one query, so they poll once between them.
 */

export interface NowMinute {
  /** The minute's start, ISO 8601. */
  start: string;
  visitors: number;
  pageviews: number;
}

export interface RightNow {
  timeZone: string;
  environment: string;
  /** When the API counted, ISO 8601. */
  at: string;
  /** Visitors active in the last 5 minutes. */
  visitors: number;
  /** Visitors active in the last 30 minutes. */
  windowVisitors: number;
  /** The last 30 minutes, oldest first; the last one is still running. */
  perMinute: NowMinute[];
  pages: { path: string; visitors: number; pageviews: number }[];
  sources: { value: string; visitors: number }[];
  /** null: unknown. */
  countries: { value: string | null; visitors: number }[];
}

/** How often the numbers are asked for while the tab shows. A test may shorten it. */
export const NOW_TIMING = { refreshMs: 15_000 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number";
const isText = (value: unknown): value is string => typeof value === "string";
const listOf = (value: unknown, isItem: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.every((item) => isRecord(item) && isItem(item));

const isRightNow = (value: unknown): value is RightNow =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.at) &&
  isNumber(value.visitors) &&
  isNumber(value.windowVisitors) &&
  listOf(
    value.perMinute,
    (item) => isText(item.start) && isNumber(item.visitors) && isNumber(item.pageviews),
  ) &&
  listOf(
    value.pages,
    (item) => isText(item.path) && isNumber(item.visitors) && isNumber(item.pageviews),
  ) &&
  listOf(value.sources, (item) => isText(item.value) && isNumber(item.visitors)) &&
  listOf(
    value.countries,
    (item) => (item.value === null || isText(item.value)) && isNumber(item.visitors),
  );

/**
 * Polls while the tab shows: React Query skips an interval's request while
 * the document is hidden, and asks again when it shows. Never kept longer
 * than a poll.
 */
export const nowQuery = (source: ReportSource, environment: string) =>
  queryOptions({
    queryKey: ["analytics-now", source.key, environment],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams(environmentParams(source, environment)).toString();
      return expectShape(
        await apiRequest(`${source.path}/analytics/now${params === "" ? "" : `?${params}`}`, {
          signal,
        }),
        isRightNow,
      );
    },
    refetchInterval: () => NOW_TIMING.refreshMs,
    staleTime: () => NOW_TIMING.refreshMs,
    // While another environment loads, keep showing this one, dimmed.
    placeholderData: keepPreviousData,
  });
