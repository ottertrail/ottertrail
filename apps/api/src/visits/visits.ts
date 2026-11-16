import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";

/** A visit ends after this long without an event. */
export const VISIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How far past the end of a range the query reads, so a visit that starts
 * inside the range is complete: its exit page, duration, and whether it
 * bounced can depend on events after the range ends.
 */
export const VISIT_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

/** Reserved event names: everything else is a custom event (an interaction). */
export const PAGEVIEW = "pageview";
export const ENGAGEMENT = "engagement";

export interface Visit {
  /** The visitor ID on the day the visit started. */
  visitorId: string;
  startedAt: Date;
  /** The last event of the visit, including the final engagement report. */
  endedAt: Date;
  durationMs: number;
  /** Time pages were visible, as reported by engagement events. */
  engagedMs: number;
  pageviews: number;
  /** Custom events, such as "signup". */
  interactions: number;
  /** One pageview and no interaction. */
  bounce: boolean;
  entryPath: string | null;
  exitPath: string | null;
  // From the visit's first event: where it came from and who it was.
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
}

interface VisitRow {
  visitor_id: string;
  started_at: Date;
  ended_at: Date;
  engaged_ms: string;
  pageviews: string;
  interactions: string;
  entry_path: string | null;
  exit_path: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  browser: string | null;
  os: string | null;
  device_type: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
}

/**
 * The visits of one project that started in [from, to), worked out from
 * the stored events when asked. Nothing about visits is stored, so late,
 * out-of-order, and duplicate events are always accounted for, and the
 * rules below can change without migrating data.
 *
 * Rules:
 * - A visit is one visitor's run of events with no gap over 30 minutes.
 * - Engagement events (time on page) extend a visit but never start one:
 *   a run of only engagement events is not a visit.
 * - A visit crossing midnight continues: an event in the first 30 minutes
 *   of a day carries the visitor's ID under the previous day's salt
 *   (previous_visitor_id), and the two IDs are linked when that visitor
 *   had an event in the 30 minutes before. Links chain, so a visit can
 *   cross several midnights, and the visits of someone who is around at
 *   midnight on several nights are each joined correctly.
 * - Entry and exit pages are the first and last pageviews. Referrer,
 *   campaign, browser, and location come from the first event.
 */
export async function findVisits(
  db: Kysely<Database>,
  { projectId, from, to }: { projectId: string; from: Date; to: Date },
): Promise<Visit[]> {
  const timeoutSeconds = VISIT_TIMEOUT_MS / 1000;
  // Read 30 minutes before the range, to know whether an early event
  // continues a visit that started earlier, and a day after it.
  const readFrom = new Date(from.getTime() - VISIT_TIMEOUT_MS);
  const readTo = new Date(to.getTime() + VISIT_LOOKAHEAD_MS);

  const { rows } = await sql<VisitRow>`
    with recursive range_events as (
      select event_id, visitor_id, previous_visitor_id, name, occurred_at, path, referrer,
             utm_source, utm_medium, utm_campaign, utm_term, utm_content,
             browser, os, device_type, country, region, city, properties
      from events
      where project_id = ${projectId}
        and visitor_id is not null
        and occurred_at >= ${readFrom}
        and occurred_at < ${readTo}
    ),
    -- After midnight, a visitor has a new ID. Join it to yesterday's ID when
    -- yesterday's visitor had an event in the 30 minutes before.
    links as (
      select distinct on (today.visitor_id)
             today.visitor_id as today_id, today.previous_visitor_id as yesterday_id
      from range_events today
      join range_events yesterday
        on yesterday.visitor_id = today.previous_visitor_id
       and yesterday.occurred_at <= today.occurred_at
       and yesterday.occurred_at >= today.occurred_at - make_interval(secs => ${timeoutSeconds})
      where today.previous_visitor_id is not null
      order by today.visitor_id, today.occurred_at
    ),
    -- Someone who is around at midnight on several nights has a chain of
    -- links: Wednesday's ID to Tuesday's, Tuesday's to Monday's. Every ID in
    -- a chain gets the chain's first ID as its person key. (Recursive: start
    -- at the links whose earlier ID is not linked itself, then follow them.)
    people (visitor_id, person) as (
      select today_id, yesterday_id from links
      where yesterday_id not in (select today_id from links)
      union
      select links.today_id, people.person
      from links join people on links.yesterday_id = people.visitor_id
    ),
    keyed as (
      select range_events.*, coalesce(people.person, range_events.visitor_id) as person
      from range_events
      left join people on people.visitor_id = range_events.visitor_id
    ),
    -- A new visit starts at a person's first event, or after a gap over 30 minutes.
    marked as (
      select keyed.*,
             case
               when lag(occurred_at) over by_person is null then 1
               when occurred_at - lag(occurred_at) over by_person
                    > make_interval(secs => ${timeoutSeconds}) then 1
               else 0
             end as starts_visit
      from keyed
      window by_person as (partition by person order by occurred_at, event_id)
    ),
    -- A running count of visit starts numbers each person's visits: 1, 2, 3 …
    numbered as (
      select marked.*,
             sum(starts_visit) over (partition by person order by occurred_at, event_id
                                     rows unbounded preceding) as visit_number
      from marked
    ),
    visits as (
      select
        (array_agg(visitor_id order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as visitor_id,
        min(occurred_at) filter (where name <> ${ENGAGEMENT}) as started_at,
        max(occurred_at) as ended_at,
        -- A malformed value counts as 0 instead of failing the whole report.
        coalesce(sum(case when properties ->> 'engagedMs' ~ '^[0-9]{1,9}$'
                          then (properties ->> 'engagedMs')::bigint else 0 end)
                 filter (where name = ${ENGAGEMENT}), 0) as engaged_ms,
        count(*) filter (where name = ${PAGEVIEW}) as pageviews,
        count(*) filter (where name not in (${PAGEVIEW}, ${ENGAGEMENT})) as interactions,
        (array_agg(path order by occurred_at, event_id) filter (where name = ${PAGEVIEW}))[1] as entry_path,
        (array_agg(path order by occurred_at desc, event_id desc) filter (where name = ${PAGEVIEW}))[1] as exit_path,
        (array_agg(referrer order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as referrer,
        (array_agg(utm_source order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as utm_source,
        (array_agg(utm_medium order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as utm_medium,
        (array_agg(utm_campaign order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as utm_campaign,
        (array_agg(utm_term order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as utm_term,
        (array_agg(utm_content order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as utm_content,
        (array_agg(browser order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as browser,
        (array_agg(os order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as os,
        (array_agg(device_type order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as device_type,
        (array_agg(country order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as country,
        (array_agg(region order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as region,
        (array_agg(city order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as city
      from numbered
      group by person, visit_number
      having count(*) filter (where name <> ${ENGAGEMENT}) > 0
    )
    select * from visits
    where started_at >= ${from} and started_at < ${to}
    order by started_at, visitor_id
  `.execute(db);

  return rows.map((row) => {
    const pageviews = Number(row.pageviews);
    const interactions = Number(row.interactions);
    return {
      visitorId: row.visitor_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.ended_at.getTime() - row.started_at.getTime(),
      engagedMs: Number(row.engaged_ms),
      pageviews,
      interactions,
      bounce: pageviews <= 1 && interactions === 0,
      entryPath: row.entry_path,
      exitPath: row.exit_path,
      referrer: row.referrer,
      utmSource: row.utm_source,
      utmMedium: row.utm_medium,
      utmCampaign: row.utm_campaign,
      utmTerm: row.utm_term,
      utmContent: row.utm_content,
      browser: row.browser,
      os: row.os,
      deviceType: row.device_type,
      country: row.country,
      region: row.region,
      city: row.city,
    };
  });
}
