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

/**
 * Deliveries (docs/uptime-alerts.md, "Where alerts go"): a notification is
 * a row per channel in notification_deliveries, written before anything
 * is sent (notify). The worker takes due rows (takeDueDeliveries), sends
 * them (sender.ts), and records each attempt (recordAttempt). Retries wait
 * longer each time and give up after about an hour; rows are kept 30
 * days (pruneDeliveries).
 */

/**
 * How long to wait after each failed attempt before the next: 30 seconds,
 * then 1, 2, 5, 10, 20, and 20 minutes; the attempt after the last wait
 * is the last. About an hour from the first attempt to the last.
 */
export const RETRY_DELAYS_SECONDS = [30, 60, 120, 300, 600, 1200, 1200] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/**
 * How long the last attempt holds its delivery: if no outcome is recorded
 * by then (the worker stopped mid-send), it is recorded as failed. Longer
 * than any send takes (webhook.ts, email.ts).
 */
export const LAST_ATTEMPT_LEASE_SECONDS = 60;

/** Deliveries a channel takes in an hour; past it they are recorded as failed. */
export const CHANNEL_HOURLY_CAP = 60;

/** Test sends a channel takes in a minute. */
export const TEST_SENDS_PER_MINUTE = 5;

/** Days a delivery is kept, and the dashboard lists. */
export const DELIVERY_RETENTION_DAYS = 30;

/** The longest error kept with a delivery. */
export const MAX_ERROR = 300;

/** Deliveries a page of the list holds at most. */
export const MAX_DELIVERY_PAGE = 100;

const CAPPED_ERROR = `Not sent: this channel had ${CHANNEL_HOURLY_CAP} deliveries in the last hour, its limit.`;
const INTERRUPTED_ERROR = "The last attempt did not finish: the worker stopped while sending.";

/** A sentence short enough to keep, on one line. */
export function errorText(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what it replaces
  const line = text.replace(/[\u0000-\u001F\u007F]+/gu, " ").trim();
  return line.length <= MAX_ERROR ? line : `${line.slice(0, MAX_ERROR - 1)}…`;
}

/** What step 3's alert rules (and the test send) hand to notify. */
export interface NotifyInput {
  /** The channels to send to; unknown ones are skipped. */
  channelIds: readonly string[];
  type: EventType;
  project: { id: string; name: string } | null;
  /** What it is about, such as `{ type: "check", id, name }`. */
  subject: Subject;
  /** One or two sentences on what happened. */
  message: string;
  /** The dashboard's page about it: an absolute URL. */
  url: string;
  /** When it happened; now when left out. */
  time?: Date | undefined;
}

export interface Recorded {
  /** The notification's ID: every channel's body carries it as `id`. */
  notificationId: string;
  deliveries: { id: string; channelId: string; status: DeliveryStatus }[];
}

/** Throws on input no caller should send: step 3 builds it, not a dashboard user. */
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
 * Writes one delivery per channel in `channelIds` that exists, in the
 * transaction the caller holds the channels' rows in: pending and due
 * now, or refused when the channel had CHANNEL_HOURLY_CAP deliveries in
 * the last hour. Test sends have their own limit and do not count, and
 * neither do refusals, so a flood that goes on does not keep a channel
 * closed. A channel's first refusal in an hour is a failed row; later
 * ones only count on it (`refused`), so a flood does not fill the table.
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
 * Records a notification for some channels: one delivery each, which the
 * worker sends within seconds and retries for about an hour. This is what
 * alert rules (step 3 of docs/uptime-alerts.md) call. Returns the
 * notification's ID and each delivery, `failed` at once where the
 * channel's hourly cap was reached.
 */
export async function notify(db: Kysely<Database>, input: NotifyInput): Promise<Recorded> {
  const payload = payloadFor(input);
  return db.transaction().execute(async (trx) => {
    const ids = await lockChannels(trx, input.channelIds);
    return recordDeliveries(trx, ids, payload);
  });
}

/**
 * notify, in a transaction the caller holds: alert rules record the
 * notification with the alert's state and history, so either all of it
 * is written or none of it, and a restart sends nothing twice.
 */
export async function notifyIn(trx: Transaction<Database>, input: NotifyInput): Promise<Recorded> {
  const payload = payloadFor(input);
  const ids = await lockChannels(trx, input.channelIds);
  return recordDeliveries(trx, ids, payload);
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

/** A delivery the worker took, with its channel as it is now. */
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
 * Takes up to `limit` due deliveries, each one's attempt counted and its
 * next attempt moved on in the same statement, before anything is sent: a
 * delivery the worker stops sending is tried again after its wait, and
 * never by two workers at once (FOR UPDATE SKIP LOCKED). A delivery whose
 * last attempt never recorded an outcome is recorded as failed first, so
 * one that stops the worker each time is not tried for ever.
 */
export async function takeDueDeliveries(
  db: Kysely<Database>,
  { limit, now }: { limit: number; now?: Date | undefined },
): Promise<DueDelivery[]> {
  if (limit <= 0) return [];
  const at = sql`coalesce(${now ?? null}::timestamptz, now())`;
  const delays = [...RETRY_DELAYS_SECONDS, LAST_ATTEMPT_LEASE_SECONDS];
  // One transaction, so both statements read one now(); and the take
  // never touches a delivery past its last attempt, whatever the clock.
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
      // Written by notify, so never; a row that is not one fails rather than loops.
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
 * Records an attempt's outcome: sent; failed for good after the last
 * attempt or a final failure; or failed this time, to be tried again at
 * the time takeDueDeliveries set. Only the attempt that took the delivery
 * records it, so a late one never overwrites a newer outcome. Returns the
 * delivery's status, or null when it was not recorded.
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

/** A delivery as the dashboard lists it. */
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
