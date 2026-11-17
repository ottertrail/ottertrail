import { createHash } from "node:crypto";

import { type Kysely, type Selectable, sql } from "kysely";

import type { Database, EventsTable } from "../db/schema.ts";
import type { ClickHouseClient } from "./clickhouse.ts";

/** Events copied per ClickHouse insert: ClickHouse prefers few large inserts. */
export const COPY_BATCH_SIZE = 10_000;

/** "2026-11-16 12:00:00.000": how ClickHouse reads a DateTime64(3) in JSON. */
function clickHouseTime(moment: Date): string {
  return moment.toISOString().replace("T", " ").replace("Z", "");
}

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
 */
export async function copyEventsToClickHouse(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  { batchSize = COPY_BATCH_SIZE }: { batchSize?: number } = {},
): Promise<number> {
  let copied = 0;
  for (;;) {
    const count = await db.transaction().execute(async (trx) => {
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
      if (events.length === 0) return 0;

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
      await trx
        .updateTable("events")
        .set({ copied_at: sql<Date>`now()` })
        .where((eb) =>
          eb(
            eb.refTuple("project_id", "event_id"),
            "in",
            events.map((event) => eb.tuple(event.project_id, event.event_id)),
          ),
        )
        .execute();
      return events.length;
    });
    copied += count;
    if (count < batchSize) return copied;
  }
}
