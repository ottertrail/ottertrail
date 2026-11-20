import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/** One item of the signed-in user's inbox (docs/dashboard.md, "Notifications"). */
export interface InboxItem {
  id: string;
  /** An event type such as "check.down", or "error.assigned". */
  kind: string;
  title: string;
  /** null: about the instance (storage, backups). */
  project: { id: string; name: string } | null;
  /** The dashboard's path of what it is about, with its query. */
  link: string;
  createdAt: string;
  read: boolean;
}

/** GET /api/notifications */
export interface InboxPage {
  notifications: InboxItem[];
  /** Ask for the next page with it; null at the end. */
  next: string | null;
  unread: number;
}

export type InboxFilter = "all" | "unread";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

const isProject = (value: unknown) =>
  value === null || (isRecord(value) && isText(value.id) && isText(value.name));

const isItem = (value: unknown): value is InboxItem =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.kind) &&
  isText(value.title) &&
  isProject(value.project) &&
  isText(value.link) &&
  isText(value.createdAt) &&
  typeof value.read === "boolean";

const isPage = (value: unknown): value is InboxPage =>
  isRecord(value) &&
  Array.isArray(value.notifications) &&
  value.notifications.every(isItem) &&
  (value.next === null || isText(value.next)) &&
  typeof value.unread === "number";

const isCount = (value: unknown): value is { unread: number } =>
  isRecord(value) && typeof value.unread === "number";

/** How often the bell asks for the unread count while the tab is shown. */
export const UNREAD_POLL_MS = 60_000;

/**
 * The unread count: every minute while the tab is shown (React Query stops
 * polling in a hidden tab), and again when the window gets focus.
 */
export const unreadCountQuery = () =>
  queryOptions({
    queryKey: ["notifications", "unread"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/notifications/unread-count", { signal }), isCount).unread,
    refetchInterval: UNREAD_POLL_MS,
    refetchOnWindowFocus: "always",
  });

/** The inbox, newest first, `pageSize` at a time. */
export const inboxQuery = (filter: InboxFilter, pageSize: number) =>
  infiniteQueryOptions({
    queryKey: ["notifications", "list", filter, pageSize],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...(filter === "unread" ? { filter } : {}),
        limit: String(pageSize),
        ...(pageParam === "" ? {} : { before: pageParam }),
      });
      return expectShape(
        await apiRequest(`/api/notifications?${query.toString()}`, { signal }),
        isPage,
      );
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });

/** Marks one item read or unread. */
export async function markNotification(id: string, read: boolean): Promise<void> {
  await apiRequest(`/api/notifications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { read },
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  await apiRequest("/api/notifications/read-all", { method: "POST" });
}

/** After a change: the count and every list read again. */
export const refreshInbox = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: ["notifications"] });

/** "9+" past nine, as the bell's badge shows it. */
export const unreadBadge = (count: number) => (count > 9 ? "9+" : String(count));

/** The bell's accessible name: "Notifications, 3 unread". */
export const bellLabel = (count: number) =>
  count === 0 ? "Notifications" : `Notifications, ${count} unread`;
