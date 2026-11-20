import type { InboxItem } from "../../src/lib/notifications-api.ts";

/**
 * The signed-in user's notifications, as the API's inbox routes answer
 * them (apps/api/src/notifications/inbox-routes.ts): newest first, paged
 * by the last ID, marked read and unread.
 */
export interface FakeNotifications {
  items: InboxItem[];
  /** When set, the list answers this instead (a failure). */
  failure: Response | null;
}

const PROJECT = { id: "11111111-1111-4111-8111-111111111111", name: "Main site" };

/** Minutes ago. */
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Three unread and three read items, of each source. */
export function fakeNotifications(): FakeNotifications {
  return {
    failure: null,
    items: [
      {
        id: "note-1",
        kind: "check.down",
        title: "Checkout API is down",
        project: PROJECT,
        link: "/projects/11111111-1111-4111-8111-111111111111/uptime",
        createdAt: at(4),
        read: false,
      },
      {
        id: "note-2",
        kind: "error.assigned",
        title:
          "Ada Admin assigned you TypeError: Cannot read properties of undefined (reading 'id')",
        project: PROJECT,
        link: "/projects/11111111-1111-4111-8111-111111111111/errors/1-0123456789abcdef0123",
        createdAt: at(25),
        read: false,
      },
      {
        id: "note-3",
        kind: "storage.low",
        title: "The last backup failed",
        project: null,
        link: "/settings?tab=backups",
        createdAt: at(90),
        read: false,
      },
      {
        id: "note-4",
        kind: "error.new",
        title: "New error: ReferenceError: process is not defined",
        project: PROJECT,
        link: "/projects/11111111-1111-4111-8111-111111111111/errors/2-0123456789abcdef0123",
        createdAt: at(60 * 5),
        read: true,
      },
      {
        id: "note-5",
        kind: "check.up",
        title: "Checkout API is up",
        project: PROJECT,
        link: "/projects/11111111-1111-4111-8111-111111111111/uptime",
        createdAt: at(60 * 26),
        read: true,
      },
      {
        id: "note-6",
        kind: "backups.changed",
        title: "Test Owner showed the backup key",
        project: null,
        link: "/settings?tab=backups",
        createdAt: at(60 * 24 * 3),
        read: true,
      },
    ],
  };
}

/** `count` read items, for paging: "Item 1" newest. */
export function manyNotifications(count: number): InboxItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `many-${index + 1}`,
    kind: "check.up",
    title: `Item ${index + 1}`,
    project: PROJECT,
    link: "/projects/11111111-1111-4111-8111-111111111111/uptime",
    createdAt: at(index + 1),
    read: true,
  }));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const unreadOf = (state: FakeNotifications) => state.items.filter((item) => !item.read).length;

/** The answer to a notifications route, or null for any other path. */
export function answerNotifications(
  state: FakeNotifications,
  url: URL,
  init: RequestInit | undefined,
): Response | null {
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (path === "/api/notifications/unread-count") return json({ unread: unreadOf(state) });
  if (path === "/api/notifications/read-all" && method === "POST") {
    const marked = unreadOf(state);
    state.items = state.items.map((item) => ({ ...item, read: true }));
    return json({ marked });
  }
  const one = /^\/api\/notifications\/([^/]+)$/.exec(path);
  if (one?.[1] !== undefined && method === "PATCH") {
    const id = decodeURIComponent(one[1]);
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const read = typeof body === "object" && body !== null && "read" in body && body.read === true;
    if (!state.items.some((item) => item.id === id)) {
      return json(
        { error: "notification_not_found", message: "You have no notification with this ID." },
        404,
      );
    }
    state.items = state.items.map((item) => (item.id === id ? { ...item, read } : item));
    return json({ id, read });
  }
  if (path === "/api/notifications") {
    if (state.failure !== null) return state.failure.clone();
    const query = url.searchParams;
    const limit = Number(query.get("limit") ?? "30");
    const before = query.get("before");
    let items = state.items.filter((item) => query.get("filter") !== "unread" || !item.read);
    if (before !== null) items = items.slice(items.findIndex((item) => item.id === before) + 1);
    const page = items.slice(0, limit);
    return json({
      notifications: page,
      next: items.length > limit ? (page.at(-1)?.id ?? null) : null,
      unread: unreadOf(state),
    });
  }
  return null;
}
