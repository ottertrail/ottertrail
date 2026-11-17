import { createHash } from "node:crypto";

import { type Kysely, type Selectable, sql } from "kysely";

import { MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import type { Database, EventsTable } from "../db/schema.ts";
import { DELETE_BATCH_SIZE } from "../retention/retention.ts";
import type { ClickHouseClient } from "./clickhouse.ts";
import { clickHouseTime } from "./query.ts";

/** Events copied per ClickHouse insert: ClickHouse prefers few large inserts. */
export const COPY_BATCH_SIZE = 10_000;

/**
 * How long PostgreSQL keeps an event after it happened: twice
 * MAX_EVENT_AGE_MS, 48 hours. The collection endpoint refuses events more
 * than MAX_EVENT_AGE_MS old, and until then PostgreSQL's unique key must
 * still hold the event to ignore a retry of it. The age is measured on the
 * sender's clock, so a retry sent after that clock was put back by some
 * hours can arrive later than 24 hours after the event: the second day
 * covers that, and the time requests spend on the way.
 */
export const KEEP_IN_POSTGRES_MS = 2 * MAX_EVENT_AGE_MS;

/** One event as ClickHouse's events table takes it (clickhouse/migrations.ts). */
function toClickHouse(event: Selectable<EventsTable>) {
  return {
    project_id: event.project_id,
    event_id: event.event_id,
    name: event.name,
    occurred_at: clickHouseTime(event.occurred_at),
    received_at: clickHouseTime(event.received_at),
    path: event.path,
    referrer: event.referrer,
    utm_source: event.utm_source,
    utm_medium: event.utm_medium,
    utm_campaign: event.utm_campaign,
    utm_term: event.utm_term,
    utm_content: event.utm_content,
    properties: JSON.stringify(event.properties),
    browser: event.browser,
    browser_version: event.browser_version,
    os: event.os,
    device_type: event.device_type,
    country: event.country,
    region: event.region,
    city: event.city,
    // A bigint arrives as a string; ClickHouse reads it as Int64.
    visitor_id: event.visitor_id,
  };
}

/**
 * Copies events not yet in ClickHouse there, oldest arrivals first, a batch
 * at a time, and returns how many it copied. The worker runs it every few
 * seconds.
 *
 * Each event reaches ClickHouse once:
 * - PostgreSQL receives events first, and its unique (project_id,
 *   event_id) keeps retried events out before anything is copied.
 * - A batch's rows stay locked (FOR UPDATE SKIP LOCKED) until they are
 *   marked copied, so two workers never copy the same events.
 * - If the worker stops after ClickHouse stored a batch but before
 *   PostgreSQL marked it, the next run selects the same rows again.
 *   ClickHouse drops an insert identical to one of its recent ones
 *   (non_replicated_deduplication_window), and the batch also carries a
 *   deduplication token made from its events, so the drop does not depend
 *   on the rows being serialized the same way twice.
 *
 * If ClickHouse cannot be reached, nothing is marked and the events wait
 * for the next run: collection never depends on ClickHouse.
 *
 * After each batch it records when each project's latest event happened
 * (projects.last_event_at), which the dashboard shows. That happens after
 * the batch's transaction ends: deleting a project locks the project, then
 * its events, so a transaction that held events and then waited for the
 * project could deadlock with it.
 */
export async function copyEventsToClickHouse(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  { batchSize = COPY_BATCH_SIZE }: { batchSize?: number } = {},
): Promise<number> {
  let copied = 0;
  for (;;) {
    const batch = await db.transaction().execute(async (trx) => {
      const events = await trx
        .selectFrom("events")
        .selectAll()
        .where("copied_at", "is", null)
        .orderBy("received_at")
        .orderBy("project_id")
        .orderBy("event_id")
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      if (events.length === 0) return [];

      // The same rows always make the same token.
      const token = createHash("sha256")
        .update(events.map((event) => `${event.project_id}/${event.event_id}`).join("\n"))
        .digest("hex");
      await clickhouse.insert({
        table: "events",
        values: events.map(toClickHouse),
        format: "JSONEachRow",
        clickhouse_settings: { insert_deduplication_token: token },
      });
      // Two arrays, not a list of 10,000 pairs, which PostgreSQL refuses
      // as too deeply nested ("stack depth limit exceeded").
      await sql`
        update events set copied_at = now()
        from unnest(
          ${events.map((event) => event.project_id)}::uuid[],
          ${events.map((event) => event.event_id)}::uuid[]
        ) as copied(project_id, event_id)
        where events.project_id = copied.project_id and events.event_id = copied.event_id
      `.execute(trx);
      return events;
    });

    const latest = new Map<string, Date>();
    for (const event of batch) {
      const known = latest.get(event.project_id);
      if (known === undefined || event.occurred_at > known) {
        latest.set(event.project_id, event.occurred_at);
      }
    }
    // One statement per project, each its own transaction: greatest() makes
    // a repeat harmless, and a deleted project is simply not updated.
    for (const [projectId, at] of latest) {
      await db
        .updateTable("projects")
        .set({ last_event_at: sql<Date>`greatest(last_event_at, ${at})` })
        .where("id", "=", projectId)
        .execute();
    }
    copied += batch.length;
    if (batch.length < batchSize) return copied;
  }
}

/**
 * Deletes events from PostgreSQL that are in ClickHouse and too old for any
 * retry to arrive (KEEP_IN_POSTGRES_MS), and returns how many. Reports read
 * ClickHouse, so PostgreSQL only needs the events its unique key must still
 * guard, and those not yet copied. The worker runs it every hour; running
 * it twice, or in two processes at once, is harmless.
 *
 * One project at a time, in batches, along the (project_id, occurred_at)
 * index, so no delete holds its locks for long.
 */
export async function deleteCopiedEvents(
  db: Kysely<Database>,
  { now = new Date(), batchSize = DELETE_BATCH_SIZE }: { now?: Date; batchSize?: number } = {},
): Promise<number> {
  const before = new Date(now.getTime() - KEEP_IN_POSTGRES_MS);
  const projects = await db.selectFrom("projects").select("id").orderBy("id").execute();
  let deleted = 0;
  for (const { id } of projects) {
    for (;;) {
      const result = await sql`
        delete from events
        where project_id = ${id}
          and event_id in (
            select event_id from events
            where project_id = ${id} and occurred_at < ${before} and copied_at is not null
            limit ${batchSize}
          )
      `.execute(db);
      const count = Number(result.numAffectedRows ?? 0);
      deleted += count;
      if (count < batchSize) break;
    }
  }
  return deleted;
}
