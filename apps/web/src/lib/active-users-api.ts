import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import type { PeriodBefore } from "./product-api";

/*
 * Active users (docs/product-analytics.md, "Active users"): apart from
 * product-api.ts, which the router needs on a first visit, so it loads
 * with the tab.
 */

/** One day, or one week from Monday, of GET /api/projects/:id/active-users. */
export interface ActivePoint {
  /** The day, or the Monday that starts the week. */
  day: string;
  /** When it starts, in the instance's timezone (ISO). */
  start: string;
  /** Users active that day; for a week, the average over its days in the period. */
  dau: number;
  /** Users active in the 7 and 28 days ending that day, or the week's last day in the period. */
  wau: number;
  mau: number;
  /** DAU ÷ MAU, averaged over the days with any monthly user; null when there are none. */
  stickiness: number | null;
  /** They add up to the users active that day or week. */
  new: number;
  returning: number;
  resurrected: number;
}

export interface ActiveSummary {
  /** Users active on any day of the period. */
  users: number;
  averageDaily: number;
  /** The last day's WAU and MAU. */
  weekly: number;
  monthly: number;
  stickiness: number | null;
}

/** GET /api/projects/:id/active-users: signed-in users only. */
export interface ActiveUsers {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  environments: string[];
  unit: "day" | "week";
  summary: ActiveSummary;
  points: ActivePoint[];
  previous: PeriodBefore & ActiveSummary;
  /** Whether any of the project's events carries a user ID. */
  identifiesUsers: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);
const isShare = (value: unknown): value is number | null => value === null || isNumber(value);

const isActiveSummary = (value: unknown): value is ActiveSummary =>
  isRecord(value) &&
  isNumber(value.users) &&
  isNumber(value.averageDaily) &&
  isNumber(value.weekly) &&
  isNumber(value.monthly) &&
  isShare(value.stickiness);

const isActivePoint = (value: unknown): value is ActivePoint =>
  isRecord(value) &&
  isText(value.day) &&
  isText(value.start) &&
  isNumber(value.dau) &&
  isNumber(value.wau) &&
  isNumber(value.mau) &&
  isShare(value.stickiness) &&
  isNumber(value.new) &&
  isNumber(value.returning) &&
  isNumber(value.resurrected);

const isActiveUsers = (value: unknown): value is ActiveUsers =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isListOf(value.environments, isText) &&
  (value.unit === "day" || value.unit === "week") &&
  isActiveSummary(value.summary) &&
  isListOf(value.points, isActivePoint) &&
  isRecord(value.previous) &&
  isText(value.previous.firstDay) &&
  isText(value.previous.lastDay) &&
  (value.previous.until === null || isText(value.previous.until)) &&
  isActiveSummary(value.previous) &&
  typeof value.identifiesUsers === "boolean";

/** DAU, WAU, MAU, stickiness, and lifecycle of signed-in users in the range. */
export const activeUsersQuery = (projectId: string, range: PageRange, environment: string) =>
  queryOptions({
    queryKey: ["active-users", projectId, range, environment],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/active-users?${new URLSearchParams({
            ...rangeParams(range),
            ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
          }).toString()}`,
          { signal },
        ),
        isActiveUsers,
      ),
    placeholderData: keepPreviousData,
  });
