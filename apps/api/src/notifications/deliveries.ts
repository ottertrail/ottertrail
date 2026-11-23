import { randomUUID } from "node:crypto";

import { type Kysely, sql, type Transaction } from "kysely";

import type { Database, DeliveryStatus } from "../db/schema.ts";
import {
  type EventType,
  isEventType,
  MAX_MESSAGE,
  MAX_NOTIFICATION_URL,
  type NotificationPayload,
  PAYLOAD_VERSION,
  payloadOf,
  type Subject,
  subjectProblem,
} from "./events.ts";
import { type InboxOptions, recordFromPayload } from "./inbox.ts";

/**
 * Queue one delivery per channel before sending (docs/uptime-alerts.md, "Where alerts go"). The
 * worker retries for about an hour; keep rows for 30 days (pruneDeliveries).
 */

/**
 * Retry after 30 seconds, then 1, 2, 5, 10, 20, and 20 minutes. Stop after the next attempt,
 * about an hour after the first.
 */
export const RETRY_DELAYS_SECONDS = [30, 60, 120, 300, 600, 1200, 1200] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/**
 * Fail the final attempt if its worker never records an outcome. Allow longer than any send
 * (webhook.ts, email.ts).
 */
export const LAST_ATTEMPT_LEASE_SECONDS = 60;

export const CHANNEL_HOURLY_CAP = 60;

export const TEST_SENDS_PER_MINUTE = 5;

export const DELIVERY_RETENTION_DAYS = 30;

export const MAX_ERROR = 300;

export const MAX_DELIVERY_PAGE = 100;

const CAPPED_ERROR = `Not sent: this channel had ${CHANNEL_HOURLY_CAP} deliveries in the last hour, which is its limit.`;
const INTERRUPTED_ERROR = "The last attempt did not finish. The worker stopped during delivery.";

export function errorText(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what it replaces
  const line = text.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim();
  return line.length <= MAX_ERROR ? line : `${line.slice(0, MAX_ERROR - 1)}…`;
}

export interface NotifyInput {
  /** The channels to send to; unknown ones are skipped. */
  channelIds: readonly string[];
  type: EventType;
  project: { id: string; name: string } | null;
  subject: Subject;
  message: string;
  url: string;
  /** When it happened; now when left out. */
  time?: Date | undefined;
  /**
   * The inbox item it also makes (inbox.ts): its title and the areas a
   * reader needs, each with a default; null for none.
   */
  inbox?: InboxOptions | null | undefined;
}

export interface Recorded {
  /** The notification's ID: every channel's body carries it as `id`. */
  notificationId: string;
  deliveries: { id: string; channelId: string; status: DeliveryStatus }[];
}

/** Validate internal callers before queueing. */
function payloadFor(input: NotifyInput): NotificationPayload {
  if (!isEventType(input.type)) throw new Error(`Unknown event type: ${String(input.type)}`);
  const message = input.message.trim();
  if (message === "" || message.length > MAX_MESSAGE) {
    throw new Error(`A notification's message has 1 to ${MAX_MESSAGE} characters`);
  }
  const url = URL.parse(input.url);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("A notification's url is an absolute http(s) URL");
  }
  if (url.href.length > MAX_NOTIFICATION_URL) throw new Error("A notification's url is too long");
  const problem = subjectProblem(input.subject);
  if (problem !== null) throw new Error(problem);
  return {
    version: PAYLOAD_VERSION,
    id: randomUUID(),
    type: input.type,
    time: (input.time ?? new Date()).toISOString(),
    project: input.project === null ? null : { id: input.project.id, name: input.project.name },
    subject: input.subject,
    message,
    url: url.href,
  };
}

/**
 * Queue existing channels under the caller's channel locks. Test sends and refusals do not
 * count toward CHANNEL_HOURLY_CAP, so sustained traffic cannot keep a channel closed. Record
 * the first refusal per hour as a failed row; count later refusals on it to bound table growth.
 */
async function recordDeliveries(
  trx: Transaction<Database>,
  channelIds: readonly string[],
  payload: NotificationPayload,
): Promise<Recorded> {
  const deliveries: Recorded["deliveries"] = [];
  if (channelIds.length === 0) return { notificationId: payload.id, deliveries };
  const counts = await sql<{ id: string; recent: string; refusal: string | null }>`
    select c.id,
      (
        select count(*) from notification_deliveries d
        where d.channel_id = c.id
          and d.created_at > now() - interval '1 hour'
          and d.refused = 0
          and d.event_type <> 'test'
      ) as recent,
      (
        select d.id from notification_deliveries d
        where d.channel_id = c.id
          and d.created_at > now() - interval '1 hour'
          and d.refused > 0
        order by d.created_at desc
        limit 1
      ) as refusal
    from notification_channels c
    where c.id = any(${[...new Set(channelIds)]}::uuid[])
    order by c.id
  `.execute(trx);
  const body = JSON.stringify(payload);
  for (const { id: channelId, recent, refusal } of counts.rows) {
    const capped = payload.type !== "test" && Number(recent) >= CHANNEL_HOURLY_CAP;
    if (capped && refusal !== null) {
      await trx
        .updateTable("notification_deliveries")
        .set((eb) => ({
          refused: eb("refused", "+", 1),
          last_error: sql<string>`${CAPPED_ERROR}::text || ' ' || (refused + 1) || ' notifications refused so far.'`,
        }))
        .where("id", "=", refusal)
        .execute();
      deliveries.push({ id: refusal, channelId, status: "failed" });
      continue;
    }
    const row = await trx
      .insertInto("notification_deliveries")
      .values({
        notification_id: payload.id,
        channel_id: channelId,
        event_type: payload.type,
        payload: body,
        status: capped ? "failed" : "pending",
        next_attempt_at: capped ? null : sql<Date>`now()`,
        last_error: capped ? CAPPED_ERROR : null,
        refused: capped ? 1 : 0,
      })
      .returning(["id", "status"])
      .executeTakeFirstOrThrow();
    deliveries.push({ id: row.id, channelId, status: row.status });
  }
  return { notificationId: payload.id, deliveries };
}

/** Locks the channels' rows, in one order, so two notifications count one after the other. */
async function lockChannels(trx: Transaction<Database>, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await trx
    .selectFrom("notification_channels")
    .select("id")
    .where("id", "in", [...new Set(ids)])
    .orderBy("id")
    .forUpdate()
    .execute();
  return rows.map((row) => row.id);
}

/**
 * Queue alert notifications (step 3 of docs/uptime-alerts.md). Return failed deliveries
 * immediately for channels at their hourly cap.
 */
export async function notify(db: Kysely<Database>, input: NotifyInput): Promise<Recorded> {
  return db.transaction().execute(async (trx) => notifyIn(trx, input));
}

/**
 * Write the notification, alert state, history, and inbox item in the caller's transaction to
 * avoid partial writes or duplicate sends after restart (inbox.ts).
 */
export async function notifyIn(trx: Transaction<Database>, input: NotifyInput): Promise<Recorded> {
  const payload = payloadFor(input);
  const ids = await lockChannels(trx, input.channelIds);
  const recorded = await recordDeliveries(trx, ids, payload);
  // Create an inbox item even when there are no channels.
  if (input.inbox !== null) await recordFromPayload(trx, payload, input.inbox ?? {});
  return recorded;
}

/**
 * The dashboard's test send: a `test` notification to one channel, unless
 * it had TEST_SENDS_PER_MINUTE test sends in the last minute. Null when
 * the channel does not exist.
 */
export async function sendTest(
  db: Kysely<Database>,
  channelId: string,
  input: Omit<NotifyInput, "channelIds" | "type">,
): Promise<Recorded | { limited: true } | null> {
  const payload = payloadFor({ ...input, channelIds: [channelId], type: "test" });
  return db.transaction().execute(async (trx) => {
    const [id] = await lockChannels(trx, [channelId]);
    if (id === undefined) return null;
    const { count } = await trx
      .selectFrom("notification_deliveries")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("channel_id", "=", id)
      .where("event_type", "=", "test")
      .where("created_at", ">", sql<Date>`now() - interval '1 minute'`)
      .executeTakeFirstOrThrow();
    if (Number(count) >= TEST_SENDS_PER_MINUTE) return { limited: true as const };
    return recordDeliveries(trx, [id], payload);
  });
}

export interface DueDelivery {
  id: string;
  channelId: string;
  payload: NotificationPayload;
  /** This attempt's number, from 1. */
  attempt: number;
  kind: "email" | "webhook";
  addresses: string[] | null;
  url: string | null;
  secret: string | null;
}

/**
 * Claim deliveries with FOR UPDATE SKIP LOCKED and advance attempts before sending, so a crash
 * allows retry and workers cannot send concurrently. Fail abandoned final attempts first to
 * prevent endless retries.
 */
export async function takeDueDeliveries(
  db: Kysely<Database>,
  { limit, now }: { limit: number; now?: Date | undefined },
): Promise<DueDelivery[]> {
  if (limit <= 0) return [];
  const at = sql`coalesce(${now ?? null}::timestamptz, now())`;
  const delays = [...RETRY_DELAYS_SECONDS, LAST_ATTEMPT_LEASE_SECONDS];
  // Use one transaction so both statements share now() and cannot take an expired final
  // attempt.
  const rows = await db.transaction().execute(async (trx) => {
    await sql`
      update notification_deliveries
      set status = 'failed', next_attempt_at = null, last_error = ${INTERRUPTED_ERROR}
      where status = 'pending' and attempts >= ${MAX_ATTEMPTS} and next_attempt_at <= ${at}
    `.execute(trx);
    const taken = await sql<{
      id: string;
      channel_id: string;
      payload: unknown;
      attempts: number;
      kind: "email" | "webhook";
      email_addresses: string[] | null;
      webhook_url: string | null;
      webhook_secret: string | null;
    }>`
      with due as (
        select id from notification_deliveries
        where status = 'pending' and attempts < ${MAX_ATTEMPTS} and next_attempt_at <= ${at}
        order by next_attempt_at, id
        limit ${limit}
        for update skip locked
      )
      update notification_deliveries as d
      set attempts = d.attempts + 1,
        next_attempt_at = ${at} + make_interval(secs => (${delays}::int[])[d.attempts + 1])
      from due, notification_channels as c
      where d.id = due.id and c.id = d.channel_id
      returning d.id, d.channel_id, d.payload, d.attempts, c.kind, c.email_addresses,
        c.webhook_url, c.webhook_secret
    `.execute(trx);
    return taken.rows;
  });
  const taken: DueDelivery[] = [];
  for (const row of rows) {
    const payload = payloadOf(row.payload);
    if (payload === null) {
      // Fail malformed stored payloads instead of retrying forever.
      await recordAttempt(
        db,
        { id: row.id, attempt: row.attempts },
        { ok: false, error: "The stored notification could not be read.", final: true },
      );
      continue;
    }
    taken.push({
      id: row.id,
      channelId: row.channel_id,
      payload,
      attempt: row.attempts,
      kind: row.kind,
      addresses: row.email_addresses,
      url: row.webhook_url,
      secret: row.webhook_secret,
    });
  }
  return taken;
}

/** How one attempt went; `final` when retrying cannot help (email not set up). */
export type AttemptOutcome = { ok: true } | { ok: false; error: string; final?: boolean };

/**
 * Record only the claimed attempt so late completions cannot overwrite newer outcomes. Retry
 * unless the last attempt or a final failure ends delivery; null means nothing was recorded.
 */
export async function recordAttempt(
  db: Kysely<Database>,
  delivery: { id: string; attempt: number },
  outcome: AttemptOutcome,
  now?: Date,
): Promise<DeliveryStatus | null> {
  const at = sql<Date>`coalesce(${now ?? null}::timestamptz, now())`;
  const giveUp = !outcome.ok && (outcome.final === true || delivery.attempt >= MAX_ATTEMPTS);
  const row = await db
    .updateTable("notification_deliveries")
    .set(
      outcome.ok
        ? { status: "sent", sent_at: at, next_attempt_at: null, last_error: null }
        : giveUp
          ? { status: "failed", next_attempt_at: null, last_error: errorText(outcome.error) }
          : { last_error: errorText(outcome.error) },
    )
    .where("id", "=", delivery.id)
    .where("status", "=", "pending")
    .where("attempts", "=", delivery.attempt)
    .returning("status")
    .executeTakeFirst();
  return row?.status ?? null;
}

/** Deletes deliveries older than DELIVERY_RETENTION_DAYS; how many. */
export async function pruneDeliveries(db: Kysely<Database>, now?: Date): Promise<number> {
  const at = sql`coalesce(${now ?? null}::timestamptz, now())`;
  const result = await db
    .deleteFrom("notification_deliveries")
    .where("created_at", "<", sql<Date>`${at} - make_interval(days => ${DELIVERY_RETENTION_DAYS})`)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export interface Delivery {
  id: string;
  notificationId: string;
  type: string;
  message: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

/**
 * A channel's deliveries of the last DELIVERY_RETENTION_DAYS, newest
 * first, `limit` at a time: `before` is the last ID of the page before,
 * and `next` the ID to ask for the following page with (null at the end).
 */
export async function listDeliveries(
  db: Kysely<Database>,
  channelId: string,
  { before, limit }: { before?: string | undefined; limit: number },
): Promise<{ deliveries: Delivery[]; next: string | null }> {
  let query = db
    .selectFrom("notification_deliveries as d")
    .select([
      "d.id",
      "d.notification_id",
      "d.event_type",
      "d.payload",
      "d.status",
      "d.attempts",
      "d.next_attempt_at",
      "d.last_error",
      "d.created_at",
      "d.sent_at",
    ])
    .where("d.channel_id", "=", channelId)
    .where(
      "d.created_at",
      ">=",
      sql<Date>`now() - make_interval(days => ${DELIVERY_RETENTION_DAYS})`,
    );
  if (before !== undefined) {
    query = query.where(
      sql<boolean>`(d.created_at, d.id) < (
        select created_at, id from notification_deliveries
        where id = ${before} and channel_id = ${channelId}
      )`,
    );
  }
  const rows = await query
    .orderBy("d.created_at", "desc")
    .orderBy("d.id", "desc")
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  return {
    deliveries: page.map((row) => ({
      id: row.id,
      notificationId: row.notification_id,
      type: row.event_type,
      message: payloadOf(row.payload)?.message ?? "",
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    })),
    next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
