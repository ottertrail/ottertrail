import { infiniteQueryOptions, keepPreviousData } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT } from "./analytics-api";
import { apiRequest, expectShape } from "./api";

/** A known user: the site's own ID for someone signed in, with when they were seen. */
export interface User {
  userId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Pageviews and custom events with the user's ID. */
  events: number;
}

/** One page of GET /api/projects/:id/users. */
export interface UserList {
  timeZone: string;
  environment: string;
  environments: string[];
  users: User[];
  hasMore: boolean;
}

/** What went wrong, for an error event, and its group on the Errors page. */
export interface ActivityError {
  type: string;
  message: string;
  fingerprint: string;
}

/** One event of a user's activity. */
export interface Activity {
  eventId: string;
  /** "pageview", "error", or a custom event's name. */
  name: string;
  occurredAt: string;
  path: string;
  referrer: string | null;
  properties: Record<string, unknown>;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  release: string | null;
  /** For an error event; null for the others. */
  error: ActivityError | null;
}

/** One page of GET /api/projects/:id/users/:userId. */
export interface UserActivity {
  timeZone: string;
  environment: string;
  user: User;
  activity: Activity[];
  hasMore: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || isText(value);

const isUser = (value: unknown): value is User =>
  isRecord(value) &&
  isText(value.userId) &&
  isText(value.firstSeenAt) &&
  isText(value.lastSeenAt) &&
  typeof value.events === "number";

const isUserList = (value: unknown): value is UserList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  Array.isArray(value.environments) &&
  value.environments.every(isText) &&
  Array.isArray(value.users) &&
  value.users.every(isUser) &&
  typeof value.hasMore === "boolean";

const isActivityError = (value: unknown): value is ActivityError =>
  isRecord(value) && isText(value.type) && isText(value.message) && isText(value.fingerprint);

const isActivity = (value: unknown): value is Activity =>
  isRecord(value) &&
  isText(value.eventId) &&
  isText(value.name) &&
  isText(value.occurredAt) &&
  isText(value.path) &&
  isTextOrNull(value.referrer) &&
  isRecord(value.properties) &&
  isTextOrNull(value.browser) &&
  isTextOrNull(value.os) &&
  isTextOrNull(value.deviceType) &&
  isTextOrNull(value.country) &&
  isTextOrNull(value.region) &&
  isTextOrNull(value.city) &&
  isTextOrNull(value.release) &&
  (value.error === null || isActivityError(value.error));

const isUserActivity = (value: unknown): value is UserActivity =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isUser(value.user) &&
  Array.isArray(value.activity) &&
  value.activity.every(isActivity) &&
  typeof value.hasMore === "boolean";

/** The API's environment parameter: left out for the default. */
const environmentParams = (environment: string): Record<string, string> =>
  environment === DEFAULT_ENVIRONMENT ? {} : { environment };

/** The project's known users, most recently seen first, 50 at a time, with a search by ID. */
export const usersQuery = (projectId: string, environment: string, search: string) =>
  infiniteQueryOptions({
    queryKey: ["users", projectId, environment, search],
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...environmentParams(environment),
        ...(search === "" ? {} : { search }),
        ...(pageParam === 0 ? {} : { offset: String(pageParam) }),
      });
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return expectShape(
        await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/users${suffix}`, {
          signal,
        }),
        isUserList,
      );
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.reduce((count, page) => count + page.users.length, 0) : undefined,
    // While a new search loads, keep showing the last results.
    placeholderData: keepPreviousData,
  });

/** Where the next page of activity starts: the last event of the page before. */
interface ActivityCursor {
  before: string;
  beforeId: string;
}

/** One user and their activity, newest first, 100 events at a time. */
export const userQuery = (projectId: string, userId: string, environment: string) =>
  infiniteQueryOptions({
    queryKey: ["user", projectId, userId, environment],
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...environmentParams(environment),
        ...(pageParam === null ? {} : { ...pageParam }),
      });
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}${suffix}`,
          { signal },
        ),
        isUserActivity,
      );
    },
    initialPageParam: null as ActivityCursor | null,
    getNextPageParam: (last): ActivityCursor | undefined => {
      const oldest = last.activity.at(-1);
      return last.hasMore && oldest !== undefined
        ? { before: oldest.occurredAt, beforeId: oldest.eventId }
        : undefined;
    },
  });
