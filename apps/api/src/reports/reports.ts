import { type Kysely, type RawBuilder, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import { ENGAGEMENT, PAGEVIEW, visitsQuery } from "../visits/visits.ts";

/**
 * Report queries for the dashboard. Every number is computed from the stored
 * events when asked (see docs/web-analytics.md, section 7).
 *
 * A range is [from, to) in absolute time; localDays() turns calendar days in
 * the instance's timezone into one. Days in charts are local days too.
 */
export interface ReportRange {
  projectId: string;
  from: Date;
  to: Date;
  /** IANA timezone that days are counted in, the instance's TIMEZONE. */
  timeZone: string;
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;

const DIRECT = "Direct / none";

/**
 * The start of `firstDay` and the end of `lastDay` (both "YYYY-MM-DD",
 * inclusive) in a timezone, worked out by PostgreSQL's timezone database,
 * so days that are 23 or 25 hours long (daylight saving) come out right.
 */
export async function localDays(
  db: Kysely<Database>,
  firstDay: string,
  lastDay: string,
  timeZone: string,
): Promise<{ from: Date; to: Date }> {
  const { rows } = await sql<{ from: Date; to: Date }>`
    select (${firstDay}::date)::timestamp at time zone ${timeZone} as "from",
           (${lastDay}::date + 1)::timestamp at time zone ${timeZone} as "to"
  `.execute(db);
  const [row] = rows;
  if (row === undefined) throw new Error("localDays returned no row");
  return row;
}

const count = (value: unknown) => Number(value ?? 0);
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const average = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/** Events in the range that a person caused: pageviews and custom events, not engagement reports. */
function activity({ projectId, from, to }: ReportRange): RawBuilder<unknown> {
  return sql`
    select * from events
    where project_id = ${projectId}
      and occurred_at >= ${from} and occurred_at < ${to}
      and visitor_id is not null
      and name <> ${ENGAGEMENT}
  `;
}

export interface Summary {
  /** Distinct visitor IDs. IDs change daily, so a person counts once per day they visited. */
  visitors: number;
  pageviews: number;
  visits: number;
  viewsPerVisit: number | null;
  /** Share of visits with one pageview and no interaction, from 0 to 1. */
  bounceRate: number | null;
  avgDurationMs: number | null;
  avgEngagedMs: number | null;
}

export async function summary(db: Kysely<Database>, range: ReportRange): Promise<Summary> {
  const { rows } = await sql<Record<string, string | null>>`
    with activity as (${activity(range)}),
         visits as (${visitsQuery(range, { firstEventColumns: false })})
    select
      (select count(distinct visitor_id) from activity) as visitors,
      (select count(*) from activity where name = ${PAGEVIEW}) as pageviews,
      (select count(*) from visits) as visits,
      (select sum(pageviews) from visits) as visit_pageviews,
      (select count(*) from visits where bounce) as bounces,
      (select avg(duration_ms) from visits) as avg_duration_ms,
      (select avg(engaged_ms) from visits) as avg_engaged_ms
  `.execute(db);
  const row = rows[0] ?? {};
  const visits = count(row.visits);
  return {
    visitors: count(row.visitors),
    pageviews: count(row.pageviews),
    visits,
    viewsPerVisit: ratio(count(row.visit_pageviews), visits),
    bounceRate: ratio(count(row.bounces), visits),
    avgDurationMs: average(row.avg_duration_ms),
    avgEngagedMs: average(row.avg_engaged_ms),
  };
}

export interface DayPoint {
  /** "YYYY-MM-DD" in the report's timezone. Days without data are included with zeros. */
  day: string;
  visitors: number;
  pageviews: number;
  visits: number;
}

export async function timeseries(db: Kysely<Database>, range: ReportRange): Promise<DayPoint[]> {
  const { timeZone } = range;
  const { rows } = await sql<Record<string, string>>`
    with activity as (${activity(range)}),
         visits as (${visitsQuery(range, { firstEventColumns: false })}),
         days as (
           select generate_series(
             (${range.from}::timestamptz at time zone ${timeZone})::date,
             ((${range.to}::timestamptz - interval '1 microsecond') at time zone ${timeZone})::date,
             interval '1 day'
           )::date as day
         ),
         by_day as (
           select (occurred_at at time zone ${timeZone})::date as day,
                  count(distinct visitor_id) as visitors,
                  count(*) filter (where name = ${PAGEVIEW}) as pageviews
           from activity group by 1
         ),
         visits_by_day as (
           select (started_at at time zone ${timeZone})::date as day, count(*) as visits
           from visits group by 1
         )
    select days.day::text as day,
           coalesce(by_day.visitors, 0) as visitors,
           coalesce(by_day.pageviews, 0) as pageviews,
           coalesce(visits_by_day.visits, 0) as visits
    from days
    left join by_day on by_day.day = days.day
    left join visits_by_day on visits_by_day.day = days.day
    order by days.day
  `.execute(db);
  return rows.map((row) => ({
    day: String(row.day),
    visitors: count(row.visitors),
    pageviews: count(row.pageviews),
    visits: count(row.visits),
  }));
}

export interface PageRow {
  path: string;
  pageviews: number;
  visitors: number;
  /** Average time the page was visible per engagement report, or null without reports. */
  avgEngagedMs: number | null;
}

export async function topPages(
  db: Kysely<Database>,
  range: ReportRange,
  limit = DEFAULT_LIMIT,
): Promise<PageRow[]> {
  const { projectId, from, to } = range;
  const { rows } = await sql<Record<string, string | null>>`
    with views as (
           select path, count(*) as pageviews, count(distinct visitor_id) as visitors
           from (${activity(range)}) as activity
           where name = ${PAGEVIEW}
           group by path
         ),
         engagement as (
           select path,
                  avg(case when properties ->> 'engagedMs' ~ '^[0-9]{1,9}$'
                           then (properties ->> 'engagedMs')::bigint end) as avg_engaged_ms
           from events
           where project_id = ${projectId} and occurred_at >= ${from} and occurred_at < ${to}
             and name = ${ENGAGEMENT}
           group by path
         )
    select views.path, views.pageviews, views.visitors, engagement.avg_engaged_ms
    from views left join engagement using (path)
    order by views.visitors desc, views.pageviews desc, views.path
    limit ${clampLimit(limit)}
  `.execute(db);
  return rows.map((row) => ({
    path: String(row.path),
    pageviews: count(row.pageviews),
    visitors: count(row.visitors),
    avgEngagedMs: average(row.avg_engaged_ms),
  }));
}

/** What a visit breakdown can group by. */
export const VISIT_DIMENSION_NAMES = [
  "source",
  "entryPage",
  "exitPage",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "country",
  "region",
  "city",
  "deviceType",
  "browser",
  "os",
] as const;

export type VisitDimension = (typeof VISIT_DIMENSION_NAMES)[number];

/** For names arriving from outside, such as an HTTP request. */
export function isVisitDimension(name: string): name is VisitDimension {
  return (VISIT_DIMENSION_NAMES as readonly string[]).includes(name);
}

/** Each dimension maps to a fixed SQL expression over the visits query, so no caller input becomes SQL. */
const VISIT_DIMENSIONS: Record<VisitDimension, RawBuilder<unknown>> = {
  source: sql`source`,
  entryPage: sql`entry_path`,
  exitPage: sql`exit_path`,
  utmSource: sql`utm_source`,
  utmMedium: sql`utm_medium`,
  utmCampaign: sql`utm_campaign`,
  country: sql`country`,
  // Region and city names repeat across countries ("Springfield"), so the country is kept.
  region: sql`case when region is not null then region || ', ' || coalesce(country, '?') end`,
  city: sql`case when city is not null then city || ', ' || coalesce(country, '?') end`,
  deviceType: sql`device_type`,
  browser: sql`browser`,
  os: sql`os`,
};

export interface BreakdownRow {
  /** null means unknown: no referrer host, no location, an unrecognized browser … */
  value: string | null;
  visitors: number;
  visits: number;
  bounceRate: number | null;
}

/**
 * Visits grouped by one dimension, most visitors first.
 *
 * The source of a visit is its utm_source if set, otherwise the website
 * that linked to it (without "www."), otherwise "Direct / none". A referrer
 * on one of the project's own allowed hostnames is in-app navigation, not a
 * source, so it also counts as direct.
 */
export async function breakdown(
  db: Kysely<Database>,
  range: ReportRange,
  dimension: VisitDimension,
  limit = DEFAULT_LIMIT,
): Promise<BreakdownRow[]> {
  // TypeScript checks callers; this guards JavaScript callers and bad input.
  if (!isVisitDimension(dimension)) throw new Error("Unknown breakdown dimension");
  const column = VISIT_DIMENSIONS[dimension];
  const { rows } = await sql<Record<string, string | null>>`
    with own_hosts as (
           select lower(regexp_replace(hostname, '^www\\.', '')) as host
           from projects, unnest(allowed_hostnames) as hostname
           where id = ${range.projectId}
         ),
         visits as (
           select visits.*,
                  coalesce(
                    visits.utm_source,
                    case when referrer_host is not null
                          and referrer_host not in (select host from own_hosts)
                         then referrer_host end,
                    ${DIRECT}
                  ) as source
           from (
             select v.*,
                    -- The host after "scheme://": a bracketed IPv6 address
                    -- ("[2001:db8::1]") whole, otherwise up to a port or path.
                    lower(regexp_replace(substring(v.referrer from '^[a-zA-Z][a-zA-Z0-9+.-]*://(\\[[^]]*\\]|[^/:]+)'), '^www\\.', ''))
                      as referrer_host
             from (${visitsQuery(range)}) as v
           ) as visits
         )
    select ${column} as value,
           count(distinct visitor_id) as visitors,
           count(*) as visits,
           count(*) filter (where bounce) as bounces
    from visits
    group by 1
    order by visitors desc, visits desc, value nulls last
    limit ${clampLimit(limit)}
  `.execute(db);
  return rows.map((row) => {
    const visits = count(row.visits);
    return {
      value: row.value ?? null,
      visitors: count(row.visitors),
      visits,
      bounceRate: ratio(count(row.bounces), visits),
    };
  });
}

export interface CustomEventRow {
  name: string;
  /** Times the event happened. */
  events: number;
  visitors: number;
}

/** Custom events (everything but pageviews and engagement reports), most visitors first. */
export async function customEvents(
  db: Kysely<Database>,
  range: ReportRange,
  limit = DEFAULT_LIMIT,
): Promise<CustomEventRow[]> {
  const { rows } = await sql<Record<string, string>>`
    select name, count(*) as events, count(distinct visitor_id) as visitors
    from (${activity(range)}) as activity
    where name <> ${PAGEVIEW}
    group by name
    order by visitors desc, events desc, name
    limit ${clampLimit(limit)}
  `.execute(db);
  return rows.map((row) => ({
    name: String(row.name),
    events: count(row.events),
    visitors: count(row.visitors),
  }));
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}
