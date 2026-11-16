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
  /**
   * Only visits that match every filter count, and only their events. A
   * visit lies within one local day (visitor IDs change at midnight), so
   * every event of a range belongs to exactly one of the range's visits.
   */
  filters?: readonly ReportFilter[] | undefined;
}

const hasFilters = (range: ReportRange) => (range.filters?.length ?? 0) > 0;

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

/**
 * Events in the range that a person caused: pageviews and custom events,
 * not engagement reports. With filters, only those of the counted `visits`
 * (a FROM item, such as a CTE's name).
 */
function activity(range: ReportRange, visits: RawBuilder<unknown>): RawBuilder<unknown> {
  const { projectId, from, to } = range;
  return sql`
    select * from events
    where project_id = ${projectId}
      and occurred_at >= ${from} and occurred_at < ${to}
      and visitor_id is not null
      and name <> ${ENGAGEMENT}
      ${inVisits(range, visits)}
  `;
}

/**
 * With filters, a condition on an `events` row: it belongs to one of
 * `visits`, the visitor's events from the visit's start to its end.
 * Without filters, nothing.
 *
 * For engagement reports the start is excluded. A report at the same moment
 * as a visit's first pageview sorts before it, so it can only be stale: it
 * reports time for a visit that had already ended (visits.ts).
 */
function inVisits(
  range: ReportRange,
  visits: RawBuilder<unknown>,
  { engagement = false }: { engagement?: boolean } = {},
): RawBuilder<unknown> {
  if (!hasFilters(range)) return sql``;
  const afterStart = engagement
    ? sql`events.occurred_at > counted.started_at`
    : sql`events.occurred_at >= counted.started_at`;
  return sql`
    and exists (
      select 1 from ${visits} as counted
      where counted.visitor_id = events.visitor_id
        and ${afterStart}
        and events.occurred_at <= counted.ended_at
    )
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

/**
 * Optional for every report: the visits the report counts, worked out
 * ahead. When it is left out, each report works the visits out itself; the
 * analytics endpoint works them out once and passes them to every report
 * (analytics.ts).
 */
export type VisitsSource =
  | {
      /** SQL that yields the visits, with visitsQuery's columns. */
      sql: RawBuilder<unknown>;
      /** The filters already applied to them (filterVisits). */
      filters: readonly ReportFilter[];
    }
  | undefined;

/** Filters as one comparable string, in any order. */
const filtersKey = (filters: readonly ReportFilter[] = []) =>
  filters
    .map(({ name, value }) => JSON.stringify([name, value]))
    .toSorted((a, b) => a.localeCompare(b))
    .join(",");

/** The visits a report counts: `visitsSource`, or the range's visits narrowed by its filters. */
function countedVisits(
  range: ReportRange,
  visitsSource: VisitsSource,
  options: { firstEventColumns?: boolean } = {},
): RawBuilder<unknown> {
  if (visitsSource !== undefined) {
    // Reports also narrow events by range.filters; visits filtered any other
    // way would mix filtered and unfiltered numbers on one page.
    if (filtersKey(visitsSource.filters) !== filtersKey(range.filters)) {
      throw new Error("The visits source was filtered differently from the report range");
    }
    return visitsSource.sql;
  }
  // Filters read the first-event columns (source, country …).
  return filterVisits(range, visitsQuery(range, hasFilters(range) ? {} : options));
}

export async function summary(
  db: Kysely<Database>,
  range: ReportRange,
  visitsSource?: VisitsSource,
): Promise<Summary> {
  const { rows } = await sql<Record<string, string | null>>`
    with visits as (${countedVisits(range, visitsSource, { firstEventColumns: false })}),
         activity as (${activity(range, sql`visits`)})
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

export async function timeseries(
  db: Kysely<Database>,
  range: ReportRange,
  visitsSource?: VisitsSource,
): Promise<DayPoint[]> {
  const { timeZone } = range;
  const { rows } = await sql<Record<string, string>>`
    with visits as (${countedVisits(range, visitsSource, { firstEventColumns: false })}),
         activity as (${activity(range, sql`visits`)}),
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
  visitsSource?: VisitsSource,
): Promise<PageRow[]> {
  const { projectId, from, to } = range;
  // PostgreSQL skips the visits CTE when nothing reads it: without filters.
  const { rows } = await sql<Record<string, string | null>>`
    with visits as (${countedVisits(range, visitsSource, { firstEventColumns: false })}),
         views as (
           select path, count(*) as pageviews, count(distinct visitor_id) as visitors
           from (${activity(range, sql`visits`)}) as activity
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
             ${inVisits(range, sql`visits`, { engagement: true })}
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

/**
 * Each dimension maps to a fixed SQL expression over a visit row with its
 * referrer's host beside it (withReferrerHost), so no caller input becomes
 * SQL. Breakdowns group by these expressions and filters compare with them,
 * so a filter matches exactly the visits its breakdown row counted.
 */
const VISIT_DIMENSIONS: Record<Exclude<VisitDimension, "source">, RawBuilder<unknown>> = {
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

/** The host after "scheme://": a bracketed IPv6 address ("[2001:db8::1]") whole, otherwise up to a port or path; without "www.". */
const REFERRER_HOST = sql`lower(regexp_replace(substring(referrer from '^[a-zA-Z][a-zA-Z0-9+.-]*://(\\[[^]]*\\]|[^/:]+)'), '^www\\.', ''))`;

/** `visits` as a FROM item named v, with its referrer's host beside each row as h.referrer_host. */
function withReferrerHost(visits: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`(${visits}) as v cross join lateral (select ${REFERRER_HOST} as referrer_host) as h`;
}

/**
 * The SQL expression of a dimension. The source of a visit is its
 * utm_source if set, otherwise the website that linked to it (without
 * "www."), otherwise "Direct / none". A referrer on one of the project's
 * own allowed hostnames is in-app navigation, not a source, so it also
 * counts as direct.
 */
function dimensionSql(dimension: VisitDimension, projectId: string): RawBuilder<unknown> {
  if (dimension !== "source") return VISIT_DIMENSIONS[dimension];
  return sql`coalesce(
    utm_source,
    case when referrer_host is not null
          and referrer_host not in (
            select lower(regexp_replace(hostname, '^www\\.', ''))
            from projects, unnest(allowed_hostnames) as hostname
            where id = ${projectId}
          )
         then referrer_host end,
    ${DIRECT}
  )`;
}

/** What a report can be narrowed by: a visit dimension, or "page" for visits that viewed a page. */
export const FILTER_NAMES = ["page", ...VISIT_DIMENSION_NAMES] as const;

export type FilterName = (typeof FILTER_NAMES)[number];

export interface ReportFilter {
  name: FilterName;
  /**
   * The value as a breakdown row shows it ("google.com", "Munich, DE",
   * "/pricing"). null matches visits where the dimension is unknown.
   */
  value: string | null;
}

export function isFilterName(name: string): name is FilterName {
  return (FILTER_NAMES as readonly string[]).includes(name);
}

/** The condition one filter puts on a visit row from withReferrerHost. */
function filterCondition(filter: ReportFilter, range: ReportRange): RawBuilder<unknown> {
  if (filter.name === "page") {
    // Visits with a pageview of the page, between their first and last event.
    return sql`exists (
      select 1 from events as viewed
      where viewed.project_id = ${range.projectId}
        and viewed.occurred_at >= ${range.from} and viewed.occurred_at < ${range.to}
        and viewed.visitor_id = v.visitor_id
        and viewed.occurred_at between v.started_at and v.ended_at
        and viewed.name = ${PAGEVIEW}
        and viewed.path is not distinct from ${filter.value}
    )`;
  }
  // TypeScript checks callers; this guards JavaScript callers and bad input.
  if (!isVisitDimension(filter.name)) throw new Error("Unknown filter");
  return sql`(${dimensionSql(filter.name, range.projectId)}) is not distinct from ${filter.value}`;
}

/**
 * Only the visits (SQL with visitsQuery's columns, including the first-event
 * columns) that match every filter of the range; all of them without filters.
 */
export function filterVisits(range: ReportRange, visits: RawBuilder<unknown>): RawBuilder<unknown> {
  const filters = range.filters ?? [];
  if (filters.length === 0) return visits;
  return sql`
    select v.* from ${withReferrerHost(visits)}
    where ${sql.join(
      filters.map((filter) => filterCondition(filter, range)),
      sql` and `,
    )}
  `;
}

export interface BreakdownRow {
  /** null means unknown: no referrer host, no location, an unrecognized browser … */
  value: string | null;
  visitors: number;
  visits: number;
  bounceRate: number | null;
}

/** Visits grouped by one dimension (see dimensionSql), most visitors first. */
export async function breakdown(
  db: Kysely<Database>,
  range: ReportRange,
  dimension: VisitDimension,
  limit = DEFAULT_LIMIT,
  visitsSource?: VisitsSource,
): Promise<BreakdownRow[]> {
  // TypeScript checks callers; this guards JavaScript callers and bad input.
  if (!isVisitDimension(dimension)) throw new Error("Unknown breakdown dimension");
  const { rows } = await sql<Record<string, string | null>>`
    select ${dimensionSql(dimension, range.projectId)} as value,
           count(distinct visitor_id) as visitors,
           count(*) as visits,
           count(*) filter (where bounce) as bounces
    from ${withReferrerHost(countedVisits(range, visitsSource))}
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
  visitsSource?: VisitsSource,
): Promise<CustomEventRow[]> {
  const { rows } = await sql<Record<string, string>>`
    with visits as (${countedVisits(range, visitsSource, { firstEventColumns: false })})
    select name, count(*) as events, count(distinct visitor_id) as visitors
    from (${activity(range, sql`visits`)}) as activity
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
