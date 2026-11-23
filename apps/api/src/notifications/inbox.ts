import { type Expression, type Kysely, type SqlBool, sql, type Transaction } from "kysely";

import type { Reach } from "../access/access.ts";
import type { Area } from "../access/areas.ts";
import type { Database, InboxPermission } from "../db/schema.ts";
import type { NotificationPayload } from "./events.ts";

/**
 * Write one inbox item per event in the same transaction as its source (deliveries.ts,
 * notifyIn; errors/assignments.ts; docs/dashboard.md, "Notifications"). Store reads separately
 * in notification_reads; a missing row means unread.
 *
 * Check current access on every read (access/access.ts, reachOf) so revoked grants hide
 * existing items immediately. Exclude items from before the account was created. No per-user
 * copies are needed.
 */

export const INBOX_RETENTION_DAYS = 90;
export const MAX_INBOX_PAGE = 100;
export const DEFAULT_INBOX_PAGE = 30;
/** Cap count queries; the bell displays 9+ before reaching this limit. */
export const MAX_UNREAD_COUNT = 1000;
const MAX_TITLE = 300;

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

export function errorTitle(type: string, message: string): string {
  if (message === "") return type === "" ? "An error" : type;
  return `${type === "" ? "Error" : type}: ${message}`;
}

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
    case "ai.latency":
      return `Slow AI calls: ${rule}`;
    case "ai.latency_resolved":
      return `AI latency normal: ${rule}`;
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
  if (type.startsWith("route.") || type.startsWith("metric.")) {
    return ["uptime_alerts", "monitoring"];
  }
  if (type.startsWith("ai.")) return ["uptime_alerts", "ai"];
  return ["uptime_alerts"];
}

export interface InboxOptions {
  /** The title; inboxTitle's when left out. */
  title?: string | undefined;
  /** The areas a reader needs at view; defaultAreas's when left out. */
  areas?: readonly Area[] | undefined;
  /**
   * Default to projects permission for instance items (Storage). Use settings for owner-only
   * items (Backups).
   */
  permission?: InboxPermission | undefined;
}

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Deduplicate by notification ID in the caller's transaction. Instance items need projects
 * permission by default, or options.permission. Skip deleted projects.
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
 * Apply current project, area, instance permission, and personal-user access to rows aliased
 * `n`. Include only items within 90 days and since account creation.
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

/** Return false for both inaccessible and missing items. */
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

export async function pruneInbox(db: Kysely<Database>, now?: Date): Promise<number> {
  const at = sql`coalesce(${now ?? null}::timestamptz, now())`;
  const result = await db
    .deleteFrom("notifications")
    .where("created_at", "<", sql<Date>`${at} - make_interval(days => ${INBOX_RETENTION_DAYS})`)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
