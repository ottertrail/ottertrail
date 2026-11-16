import { type Kysely, type RawBuilder, sql } from "kysely";

import type { Database } from "../db/schema.ts";

/** A visit ends after this long without an event. */
export const VISIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How far before and after a range the query reads. Visitor IDs change at
 * midnight in the instance's timezone, so every visit lies within one local
 * day, and no local day is longer than 25 hours (when clocks go back). With
 * this much on each side, the query sees every visit that touches the range
 * from its first event to its last: whether it started inside the range, and
 * its exit page, duration, and bounce, which can depend on later events.
 */
export const VISIT_CONTEXT_MS = 25 * 60 * 60 * 1000;

/** Reserved event names: everything else is a custom event (an interaction). */
export const PAGEVIEW = "pageview";
export const ENGAGEMENT = "engagement";

export interface Visit {
  /** The visitor ID on the day of the visit. */
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
 * SQL for the visits of one project that started in [from, to), worked out from
 * the stored events when asked. Nothing about visits is stored, so late,
 * out-of-order, and duplicate events are always accounted for, and the
 * rules below can change without migrating data.
 *
 * Rules:
 * - A visit is one visitor ID's run of events with no gap over 30 minutes.
 * - Engagement events (time on page) extend a visit but never start one:
 *   a run of only engagement events is not a visit.
 * - Visitor IDs change at midnight in the instance's timezone, so a visit
 *   that crosses midnight counts as two. Joining them would link a visitor's
 *   IDs on two days, which daily salts exist to prevent.
 * - Entry and exit pages are the first and last pageviews. Referrer,
 *   campaign, browser, and location come from the first event that is not
 *   an engagement event.
 */
export interface VisitRange {
  projectId: string;
  from: Date;
  to: Date;
}

/** Columns a visit takes from its first event that is not an engagement event. */
const FIRST_EVENT_COLUMNS = [
  "referrer",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "browser",
  "os",
  "device_type",
  "country",
  "region",
  "city",
] as const;

export interface VisitsQueryOptions {
  /**
   * Include FIRST_EVENT_COLUMNS: where the visit came from and who it was.
   * Reports that only count visits leave them out, so the query's large
   * sort carries less data.
   */
  firstEventColumns?: boolean;
}

export function visitsQuery(
  { projectId, from, to }: VisitRange,
  { firstEventColumns = true }: VisitsQueryOptions = {},
): RawBuilder<unknown> {
  const timeout = sql`make_interval(secs => ${VISIT_TIMEOUT_MS / 1000})`;
  const readFrom = new Date(from.getTime() - VISIT_CONTEXT_MS);
  const readTo = new Date(to.getTime() + VISIT_CONTEXT_MS);

  // FIRST_EVENT_COLUMNS as read from events and as aggregated per visit, or
  // nothing. The names are the constants above, never input.
  const eventColumns = firstEventColumns
    ? sql`, ${sql.join(FIRST_EVENT_COLUMNS.map((name) => sql.ref(name)))}`
    : sql``;
  const visitColumns = firstEventColumns
    ? sql`, ${sql.join(
        FIRST_EVENT_COLUMNS.map(
          (name) =>
            sql`(array_agg(${sql.ref(name)} order by occurred_at, event_id) filter (where name <> ${ENGAGEMENT}))[1] as ${sql.ref(name)}`,
        ),
      )}`
    : sql``;

  return sql`
    with range_events as (
      select event_id, visitor_id, name, occurred_at, path,
             -- Time on page as a number. A malformed value counts as 0
             -- instead of failing the whole report.
             case when name = ${ENGAGEMENT} and properties ->> 'engagedMs' ~ '^[0-9]{1,9}$'
                  then (properties ->> 'engagedMs')::bigint else 0 end as engaged_ms
             ${eventColumns}
      from events
      where project_id = ${projectId}
        and visitor_id is not null
        and occurred_at >= ${readFrom}
        and occurred_at < ${readTo}
    ),
    -- A new visit starts at a visitor's first event, or after a gap over 30 minutes.
    marked as (
      select range_events.*,
             case
               when lag(occurred_at) over by_visitor is null then 1
               when occurred_at - lag(occurred_at) over by_visitor > ${timeout} then 1
               else 0
             end as starts_visit
      from range_events
      window by_visitor as (partition by visitor_id order by occurred_at, event_id)
    ),
    -- A running count of visit starts numbers each visitor's visits: 1, 2, 3 …
    numbered as (
      select marked.*,
             sum(starts_visit) over (partition by visitor_id order by occurred_at, event_id
                                     rows unbounded preceding) as visit_number
      from marked
    ),
    visits as (
      select
        visitor_id,
        min(occurred_at) filter (where name <> ${ENGAGEMENT}) as started_at,
        max(occurred_at) as ended_at,
        sum(engaged_ms) as engaged_ms,
        count(*) filter (where name = ${PAGEVIEW}) as pageviews,
        count(*) filter (where name not in (${PAGEVIEW}, ${ENGAGEMENT})) as interactions,
        (array_agg(path order by occurred_at, event_id) filter (where name = ${PAGEVIEW}))[1] as entry_path,
        (array_agg(path order by occurred_at desc, event_id desc) filter (where name = ${PAGEVIEW}))[1] as exit_path
        ${visitColumns}
      from numbered
      group by visitor_id, visit_number
      having count(*) filter (where name <> ${ENGAGEMENT}) > 0
    )
    select visits.*,
           extract(epoch from ended_at - started_at) * 1000 as duration_ms,
           (pageviews <= 1 and interactions = 0) as bounce
    from visits
    where started_at >= ${from} and started_at < ${to}
  `;
}

/** The visits as objects, oldest first. Reports aggregate visitsQuery in SQL instead. */
export async function findVisits(db: Kysely<Database>, range: VisitRange): Promise<Visit[]> {
  const { rows } = await sql<VisitRow>`
    select * from (${visitsQuery(range)}) as visits
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
