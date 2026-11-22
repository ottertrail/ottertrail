import { type Expression, type Kysely, type SqlBool, sql, type Transaction } from "kysely";

import type { Reach } from "../access/access.ts";
import type { Area } from "../access/areas.ts";
import type { Database, InboxPermission } from "../db/schema.ts";
import type { NotificationPayload } from "./events.ts";

/**
 * The notifications inbox (docs/dashboard.md, "Notifications"): the bell
 * in the dashboard's header and the Notifications page.
 *
 * One row per thing that happened (`notifications`), written in the
 * transaction that records it: an alert firing or resolving and the
 * instance's storage and backup notices, beside their channel deliveries
 * (deliveries.ts, notifyIn), and an error assigned or regressed
 * (errors/assignments.ts). Each user's reads are rows of their own
 * (`notification_reads`); no row is unread.
 *
 * Who sees a row is decided when it is read, never when it is written:
 * its project, the areas it needs at view, the instance permission it
 * needs, and for a personal item its one user, against the reader's
 * access as it is now (access/access.ts, reachOf). So a member who loses
 * a project or an area stops seeing its items on the next request, one
 * granted it sees them, and nothing is copied per user. Items from before
 * the reader's account was made are left out, so a new member does not
 * start with 90 days of unread alerts. At a few thousand rows over 90
 * days and dozens of users, the filter reads the newest rows by the
 * `created_at` index and checks each, which costs little.
 */

/** Days an item is kept; the worker deletes older ones. */
export const INBOX_RETENTION_DAYS = 90;
/** Items a page holds at most, and by default. */
export const MAX_INBOX_PAGE = 100;
export const DEFAULT_INBOX_PAGE = 30;
/** The unread count stops at this: the bell shows 9+ long before. */
export const MAX_UNREAD_COUNT = 1000;
const MAX_TITLE = 300;

/** A title on one line, at most MAX_TITLE characters. */
export function titleText(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what it replaces
  const line = text.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim();
  return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1)}…`;
}

/** The dashboard's path of an absolute link, with its query: what the bell opens. */
export function linkPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** "TypeError: x is undefined", or the type alone. */
export function errorTitle(type: string, message: string): string {
  if (message === "") return type === "" ? "An error" : type;
  return `${type === "" ? "Error" : type}: ${message}`;
}

/** A short title for a channel notification, from its type and subject. */
export function inboxTitle(payload: NotificationPayload): string {
  const { subject } = payload;
  const rule = text(subject.ruleName);
  const error = errorTitle(text(subject.errorType), text(subject.message));
  switch (payload.type) {
    case "check.down":
      return `${text(subject.name)} is down`;
    case "check.up":
      return `${text(subject.name)} is up`;
    case "certificate.expiring":
      return `Certificate expiring: ${text(subject.host)}`;
    case "certificate.renewed":
      return `Certificate renewed: ${text(subject.host)}`;
    case "error.new":
      return `New error: ${error}`;
    case "error.regressed":
      return `Regressed: ${error}`;
    case "error.spike":
      return `Error spike: ${rule}`;
    case "error.spike_resolved":
      return `Error spike over: ${rule}`;
    case "route.latency":
      return `Slow responses: ${rule}`;
    case "route.latency_resolved":
      return `Response times normal: ${rule}`;
    case "route.failures":
      return `Failing requests: ${rule}`;
    case "route.failures_resolved":
      return `Failures normal: ${rule}`;
    case "metric.threshold":
      return `Threshold crossed: ${rule}`;
    case "metric.threshold_resolved":
      return `Back to normal: ${rule}`;
    case "ai.cost":
      return `AI cost over limit: ${rule}`;
    case "ai.cost_resolved":
      return `AI cost back under limit: ${rule}`;
    case "ai.failures":
      return `Failing AI calls: ${rule}`;
    case "ai.failures_resolved":
      return `AI failures normal: ${rule}`;
    case "alert.held_back": {
      const held = typeof subject.held === "number" ? subject.held : 0;
      return `${text(subject.name)} held back ${held} ${held === 1 ? "alert" : "alerts"}`;
    }
    default:
      // Storage and backup notices name their own title (storage/warning-job.ts).
      return payload.message;
  }
}

/** The areas a project item needs by default: alerts, and the area the alert watches. */
export function defaultAreas(type: string): Area[] {
  if (type.startsWith("error.")) return ["uptime_alerts", "errors"];
  if (type.startsWith("route.") || type.startsWith("metric.") || type.startsWith("ai.")) {
    return ["uptime_alerts", "monitoring"];
  }
  return ["uptime_alerts"];
}

/** What notifyIn adds to the inbox, besides what the payload says. */
export interface InboxOptions {
  /** The title; inboxTitle's when left out. */
  title?: string | undefined;
  /** The areas a reader needs at view; defaultAreas's when left out. */
  areas?: readonly Area[] | undefined;
  /**
   * Who sees an instance item: "projects" (the owner and admins, as the
   * Storage tab) by default, or "settings" (the owner, as the Backups tab).
   */
  permission?: InboxPermission | undefined;
}

type Db = Kysely<Database> | Transaction<Database>;

/**
 * The inbox row mirroring a channel notification, in the caller's
 * transaction: once per notification (its ID is the row's source). An
 * instance item (no project) is for the owner and admins, as the Storage
 * tab is, or for the owner alone (options.permission). Nothing for a
 * project that no longer exists.
 */
export async function recordFromPayload(
  db: Db,
  payload: NotificationPayload,
  options: InboxOptions = {},
): Promise<void> {
  if (payload.project !== null) {
    const project = await db
      .selectFrom("projects")
      .select("id")
      .where("id", "=", payload.project.id)
      .executeTakeFirst();
    if (project === undefined) return;
  }
  await db
    .insertInto("notifications")
    .values({
      kind: payload.type,
      project_id: payload.project?.id ?? null,
      permission: payload.project === null ? (options.permission ?? "projects") : null,
      areas: payload.project === null ? [] : [...(options.areas ?? defaultAreas(payload.type))],
      title: titleText(options.title ?? inboxTitle(payload)),
      link: linkPath(payload.url),
      source_id: payload.id,
      created_at: new Date(payload.time),
    })
    .onConflict((conflict) => conflict.column("source_id").doNothing())
    .execute();
}

/** An item for one user of one project, such as an error assigned to them. */
export async function recordPersonal(
  db: Db,
  item: {
    kind: string;
    projectId: string;
    userId: string;
    areas: readonly Area[];
    title: string;
    /** The dashboard's path. */
    link: string;
    at?: Date | undefined;
  },
): Promise<string> {
  const row = await db
    .insertInto("notifications")
    .values({
      kind: item.kind,
      project_id: item.projectId,
      areas: [...item.areas],
      user_id: item.userId,
      title: titleText(item.title),
      link: item.link,
      ...(item.at === undefined ? {} : { created_at: item.at }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * The condition that a row (aliased `n`) is one `reach` may see now: its
 * project reached, its areas held, its permission held, its user the
 * reader or nobody, made since the reader's account and within 90 days.
 */
function visibleTo(reach: Reach, now: Date): Expression<SqlBool> {
  const projects = reach.projects === "all" ? null : [...reach.projects];
  const areas: string[] = reach.areas;
  const permissions: string[] = reach.permissions;
  return sql<SqlBool>`(
    (n.user_id is null or n.user_id = ${reach.userId})
    and (n.permission is null or n.permission = any(${permissions}::text[]))
    and (n.project_id is null or ${projects}::uuid[] is null or n.project_id = any(${projects}::uuid[]))
    and n.areas <@ ${areas}::text[]
    and n.created_at >= (select u.created_at from dashboard_users u where u.id = ${reach.userId})
    and n.created_at > ${now}::timestamptz - make_interval(days => ${INBOX_RETENTION_DAYS})
  )`;
}

const isUnread = (userId: string) => sql<SqlBool>`not exists (
  select 1 from notification_reads r where r.user_id = ${userId} and r.notification_id = n.id
)`;

/** An item as the dashboard lists it. */
export interface InboxItem {
  id: string;
  kind: string;
  title: string;
  project: { id: string; name: string } | null;
  link: string;
  createdAt: Date;
  read: boolean;
}

/**
 * The reader's items, newest first, `limit` at a time: `before` is the
 * last ID of the page before, and `next` the ID to ask for the following
 * page with (null at the end). `unread` lists only unread items.
 */
export async function listInbox(
  db: Kysely<Database>,
  reach: Reach,
  {
    before,
    limit,
    unread,
    now = new Date(),
  }: { before?: string | undefined; limit: number; unread: boolean; now?: Date },
): Promise<{ items: InboxItem[]; next: string | null }> {
  let query = db
    .selectFrom("notifications as n")
    .leftJoin("projects as p", "p.id", "n.project_id")
    .select([
      "n.id",
      "n.kind",
      "n.title",
      "n.project_id",
      "p.name as project_name",
      "n.link",
      "n.created_at",
      sql<boolean>`exists (
        select 1 from notification_reads r where r.user_id = ${reach.userId} and r.notification_id = n.id
      )`.as("read"),
    ])
    .where(visibleTo(reach, now));
  if (unread) query = query.where(isUnread(reach.userId));
  if (before !== undefined) {
    query = query.where(
      sql<SqlBool>`(n.created_at, n.id) < (select created_at, id from notifications where id = ${before})`,
    );
  }
  const rows = await query
    .orderBy("n.created_at", "desc")
    .orderBy("n.id", "desc")
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      project:
        row.project_id === null ? null : { id: row.project_id, name: row.project_name ?? "" },
      link: row.link,
      createdAt: row.created_at,
      read: row.read,
    })),
    next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** How many of the reader's items are unread, up to MAX_UNREAD_COUNT. */
export async function unreadCount(
  db: Kysely<Database>,
  reach: Reach,
  now = new Date(),
): Promise<number> {
  const row = await db
    .selectFrom((eb) =>
      eb
        .selectFrom("notifications as n")
        .select("n.id")
        .where(visibleTo(reach, now))
        .where(isUnread(reach.userId))
        .limit(MAX_UNREAD_COUNT)
        .as("unread"),
    )
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/**
 * Marks one of the reader's items read or unread. False when the reader
 * may not see it, or it does not exist: the two answer alike.
 */
export async function markItem(
  db: Kysely<Database>,
  reach: Reach,
  id: string,
  read: boolean,
  now = new Date(),
): Promise<boolean> {
  const item = await db
    .selectFrom("notifications as n")
    .select("n.id")
    .where("n.id", "=", id)
    .where(visibleTo(reach, now))
    .executeTakeFirst();
  if (item === undefined) return false;
  if (read) {
    await db
      .insertInto("notification_reads")
      .values({ user_id: reach.userId, notification_id: item.id })
      .onConflict((conflict) => conflict.columns(["user_id", "notification_id"]).doNothing())
      .execute();
  } else {
    await db
      .deleteFrom("notification_reads")
      .where("user_id", "=", reach.userId)
      .where("notification_id", "=", item.id)
      .execute();
  }
  return true;
}

/** Marks every item the reader may see read; how many were unread. */
export async function markAllRead(
  db: Kysely<Database>,
  reach: Reach,
  now = new Date(),
): Promise<number> {
  const result = await db
    .insertInto("notification_reads")
    .columns(["user_id", "notification_id"])
    .expression((eb) =>
      eb
        .selectFrom("notifications as n")
        .select([sql<string>`cast(${reach.userId} as uuid)`.as("user_id"), "n.id"])
        .where(visibleTo(reach, now))
        .where(isUnread(reach.userId)),
    )
    .onConflict((conflict) => conflict.columns(["user_id", "notification_id"]).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n);
}

/** Deletes items older than INBOX_RETENTION_DAYS, with their reads; how many. */
export async function pruneInbox(db: Kysely<Database>, now?: Date): Promise<number> {
  const at = sql`coalesce(${now ?? null}::timestamptz, now())`;
  const result = await db
    .deleteFrom("notifications")
    .where("created_at", "<", sql<Date>`${at} - make_interval(days => ${INBOX_RETENTION_DAYS})`)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
