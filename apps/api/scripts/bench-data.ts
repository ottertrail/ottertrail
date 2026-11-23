/**
 * Generate fake events in a benchmark-only PostgreSQL schema, then copy to ClickHouse. Never use a
 * real project.
 */
import { type Kysely, type RawBuilder, sql } from "kysely";

import type { ClickHouseClient } from "../src/clickhouse/clickhouse.ts";
import { insertRows } from "../src/clickhouse/insert.ts";
import { type EventRow, toClickHouse } from "../src/collection/event-store.ts";
import type { Database } from "../src/db/schema.ts";

/** Events per ClickHouse insert: ClickHouse prefers few large inserts. */
const COPY_BATCH_SIZE = 10_000;

/** Unlogged because this table lives only for the benchmark. */
export async function createFakeEventsTable(db: Kysely<Database>): Promise<void> {
  await sql`
    create unlogged table events (
      project_id         uuid        not null,
      event_id           uuid        not null,
      name               text        not null,
      occurred_at        timestamptz not null,
      received_at        timestamptz not null,
      path               text,
      referrer           text,
      utm_source         text,
      utm_medium         text,
      utm_campaign       text,
      utm_term           text,
      utm_content        text,
      properties         jsonb       not null default '{}',
      browser            text,
      browser_version    text,
      os                 text,
      device_type        text,
      country            text,
      region             text,
      city               text,
      visitor_id         bigint,
      environment        text        not null default 'production',
      release            text,
      user_id            text,
      error_type         text,
      error_message      text,
      error_stack        text,
      error_handled      boolean,
      error_fingerprint  text,
      replay_id          uuid,
      service            text        not null default '',
      trace_id           text        not null default '',
      span_id            text        not null default '',
      primary key (project_id, event_id)
    )
  `.execute(db);
}

/** Copy in primary-key batches and return the row count. */
export async function copyFakeEvents(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
): Promise<number> {
  let copied = 0;
  let after: { projectId: string; eventId: string } | null = null;
  for (;;) {
    const position: RawBuilder<unknown> =
      after === null
        ? sql`true`
        : sql`(project_id, event_id) > (${after.projectId}::uuid, ${after.eventId}::uuid)`;
    const { rows } = await sql<EventRow>`
      select * from events where ${position} order by project_id, event_id limit ${COPY_BATCH_SIZE}
    `.execute(db);
    const last = rows.at(-1);
    if (last === undefined) return copied;
    await insertRows(clickhouse, "events", rows.map(toClickHouse));
    copied += rows.length;
    after = { projectId: last.project_id, eventId: last.event_id };
  }
}

export interface FakeVisitsOptions {
  projectId: string;
  visitCount: number;
  dayCount: number;
  /** "YYYY-MM-DD", the first of dayCount days the visits start on (UTC). */
  firstDay: string;
}

export async function seedFakeVisits(
  db: Kysely<Database>,
  { projectId, visitCount, dayCount, firstDay }: FakeVisitsOptions,
): Promise<void> {
  // Each visit: 1-5 pages two minutes apart, an engagement report per page,
  // a referrer on the first page, and a signup in 10% of visits. About 60%
  // as many visitors as visits each day, so some visitors come back.
  await sql`
    with visits as (
      select v,
             (${firstDay}::date)::timestamptz + random() * (${dayCount} * interval '1 day') as started_at,
             1 + floor(random() * 5)::int as pages,
             (array['https://www.google.com/', 'https://news.ycombinator.com/', 'https://twitter.com/',
                    'https://example.com/', null, null])[1 + floor(random() * 6)::int] as referrer,
             (array['DE', 'US', 'GB', 'SG', 'FR', 'IN', 'BR'])[1 + floor(random() * 7)::int] as country,
             (array['Chrome', 'Safari', 'Firefox', 'Microsoft Edge'])[1 + floor(random() * 4)::int] as browser,
             (array['desktop', 'mobile', 'tablet'])[1 + floor(random() * 3)::int] as device_type,
             random() < 0.15 as from_newsletter
      from generate_series(1, ${visitCount}) as v
    ),
    visitors as (
      select visits.*,
             floor(extract(epoch from started_at) / 86400)::bigint * 1000000000
               + v % greatest(1, (${visitCount} * 0.6 / ${dayCount})::int) as visitor_id
      from visits
    )
    insert into events (project_id, event_id, name, occurred_at, received_at, path, referrer,
                        utm_source, utm_campaign, browser, device_type, country, visitor_id, properties)
    select ${projectId}, gen_random_uuid(), e.name, e.at, e.at, page.path, e.referrer,
           e.utm_source, e.utm_campaign, w.browser, w.device_type, w.country, w.visitor_id, e.properties
    from visitors w
    cross join lateral generate_series(0, w.pages - 1) as p(i)
    cross join lateral (
      select (array['/', '/pricing', '/docs', '/blog', '/signup', '/about'])[1 + (w.v + p.i) % 6] as path
    ) as page
    cross join lateral (
      values
        ('pageview', w.started_at + p.i * interval '2 minutes',
         case when p.i = 0 then w.referrer end,
         case when p.i = 0 and w.from_newsletter then 'newsletter' end,
         case when p.i = 0 and w.from_newsletter then 'launch' end,
         '{}'::jsonb),
        ('engagement', w.started_at + p.i * interval '2 minutes' + interval '90 seconds',
         null, null, null, jsonb_build_object('engagedMs', floor(random() * 90000)::int))
    ) as e(name, at, referrer, utm_source, utm_campaign, properties)
  `.execute(db);
  await sql`
    insert into events (project_id, event_id, name, occurred_at, received_at, path, visitor_id)
    select project_id, gen_random_uuid(), 'signup', occurred_at + interval '30 seconds',
           occurred_at + interval '30 seconds', path, visitor_id
    from events
    where name = 'pageview' and referrer is not null and random() < 0.2
  `.execute(db);
}
