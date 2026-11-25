import { infiniteQueryOptions, keepPreviousData } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isOccurrenceReplay, type OccurrenceReplay } from "./errors-api";
import { isReplaySummary, type ReplaySummary } from "./replays-api";

/** A known user: the site's own ID for someone signed in, with when they were seen. */
export interface User {
  userId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Pageviews and custom events with the user's ID. */
  events: number;
}

/** A user in the list, and whether the deletion of their data is pending. */
export interface ListedUser extends User {
  deletionPending: boolean;
}

/** The project's deletions of users' data still to be done: how many, and the oldest few. */
export interface PendingDeletions {
  count: number;
  users: { userId: string; requestedAt: string }[];
}

/** One page of GET /api/projects/:id/users. */
export interface UserList {
  timeZone: string;
  environment: string;
  /** Whether the project accepts only user IDs signed by its server; if not, anyone with the public key could send any ID. */
  signedUserIdsRequired: boolean;
  environments: string[];
  pendingDeletions: PendingDeletions;
  users: ListedUser[];
  hasMore: boolean;
}

/** What went wrong, for an error event, and its group on the Errors page. */
export interface ActivityError {
  type: string;
  message: string;
  fingerprint: string;
}

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
  /** For an error event: the session replay its page sent with it, if any. */
  replay: OccurrenceReplay | null;
}

/** One page of GET /api/projects/:id/users/:userId. */
export interface UserActivity {
  timeZone: string;
  environment: string;
  /** Whether the project accepts only user IDs signed by its server; if not, anyone with the public key could send any ID. */
  signedUserIdsRequired: boolean;
  /** When the deletion of the user's data was asked for, while it is pending; null otherwise. */
  deletionRequestedAt: string | null;
  user: User;
  activity: Activity[];
  hasMore: boolean;
  /** The user's latest session replays in the environment; on the first page only. */
  replays: ReplaySummary[];
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

const isListedUser = (value: unknown): value is ListedUser =>
  isUser(value) && isRecord(value) && typeof value.deletionPending === "boolean";

const isPendingDeletions = (value: unknown): value is PendingDeletions =>
  isRecord(value) &&
  typeof value.count === "number" &&
  Array.isArray(value.users) &&
  value.users.every((user) => isRecord(user) && isText(user.userId) && isText(user.requestedAt));

const isUserList = (value: unknown): value is UserList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  typeof value.signedUserIdsRequired === "boolean" &&
  Array.isArray(value.environments) &&
  value.environments.every(isText) &&
  isPendingDeletions(value.pendingDeletions) &&
  Array.isArray(value.users) &&
  value.users.every(isListedUser) &&
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
  (value.error === null || isActivityError(value.error)) &&
  (value.replay === null || isOccurrenceReplay(value.replay));

const isUserActivity = (value: unknown): value is UserActivity =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  typeof value.signedUserIdsRequired === "boolean" &&
  isTextOrNull(value.deletionRequestedAt) &&
  isUser(value.user) &&
  Array.isArray(value.activity) &&
  value.activity.every(isActivity) &&
  typeof value.hasMore === "boolean" &&
  Array.isArray(value.replays) &&
  value.replays.every(isReplaySummary);

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
    // While deletions are pending, look again until they are done.
    refetchInterval: (query) =>
      (query.state.data?.pages[0]?.pendingDeletions.count ?? 0) > 0 ? PENDING_POLL_MS : false,
  });

/** How often a page with a pending deletion asks again: the worker runs every minute. */
export const PENDING_POLL_MS = 10_000;

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
    // Until the deletion is done, when the user has no events left (404).
    refetchInterval: (query) =>
      query.state.status === "error" ||
      (query.state.data?.pages[0]?.deletionRequestedAt ?? null) === null
        ? false
        : PENDING_POLL_MS,
  });

/**
 * Starts deleting everything stored about the user in the project
 * (DELETE /api/projects/:id/users/:userId). The server's worker does it
 * within a minute or so.
 */
export async function deleteUserData(projectId: string, userId: string): Promise<void> {
  await apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}
