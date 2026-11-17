import { type Kysely, sql } from "kysely";

import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { ENGAGEMENT, PAGEVIEW, type VisitsQueryOptions, visitsSql } from "../visits/visits.ts";

/**
 * Report queries for the dashboard, run in ClickHouse. Every number is
 * computed from the stored events when asked (see docs/web-analytics.md,
 * section 7, and docs/clickhouse.md).
 *
 * A range is [from, to) in absolute time; localDays() turns calendar days in
 * the organization's timezone into one. Days in charts are local days too.
 */
export interface ReportRange {
  projectId: string;
  /**
   * The one environment reports count ("production", "staging" …): the
   * events of others never mix in (collection/environment.ts).
   */
  environment: string;
  from: Date;
  to: Date;
  /** IANA timezone that days are counted in, the timezone of the project's organization. */
  timeZone: string;
  /**
   * The project's allowed hostnames. A referrer on one of them is in-app
   * navigation, not a source, so it counts as direct.
   */
  ownHostnames: readonly string[];
  /**
   * Only visits that match every filter count, and only their events. A
   * visit lies within one local day (visitor IDs change at midnight), so
   * every event of a range belongs to exactly one of the range's visits.
   */
  filters?: readonly ReportFilter[] | undefined;
  /**
   * Ignore events from this moment on, as if they had not happened yet:
   * for a comparison up to a time of day. Every report reads events up to
   * rangeEnd(), and visits only see events before it (VisitRange.until).
   */
  until?: Date | undefined;
}

/** Where a report stops reading events: `to`, or `until` when that is earlier. */
const rangeEnd = ({ to, until }: ReportRange): Date =>
  until !== undefined && until < to ? until : to;

const hasFilters = (range: ReportRange) => (range.filters?.length ?? 0) > 0;

/** Rows a report returns unless told otherwise, and the most it ever returns. */
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;

/** Rows a list can skip: far past any list worth paging through. */
const MAX_OFFSET = 100_000;

/** For "show all": a page further down a list, and only rows whose name contains `search`. */
export interface ListOptions {
  offset?: number | undefined;
  search?: string | undefined;
}

/**
 * A condition that the text `expression` contains `search`, case ignored,
 * taken literally (no wildcards); always true without a search.
 */
function nameContains(expression: string, search: string | undefined, params: QueryParams): string {
  if (search === undefined || search === "") return "1";
  return `positionCaseInsensitiveUTF8(${expression}, ${params.add(search, "String")}) > 0`;
}

function clampOffset(offset: number | undefined): number {
  return offset === undefined || !Number.isInteger(offset) || offset < 0
    ? 0
    : Math.min(offset, MAX_OFFSET);
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Country codes whose English name contains the search, or that equal it:
 * a country list shows names, but stores codes. Every two-letter code the
 * runtime can name.
 */
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_CODES = Array.from({ length: 26 * 26 }, (_, index) =>
  String.fromCodePoint(65 + Math.floor(index / 26), 65 + (index % 26)),
).filter((code) => countryNames.of(code) !== code);

function countryCodesMatching(search: string): string[] {
  const needle = search.toLowerCase();
  return COUNTRY_CODES.filter(
    (code) =>
      code.toLowerCase() === needle || (countryNames.of(code) ?? "").toLowerCase().includes(needle),
  );
}

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

export interface PreviousDays {
  /** "YYYY-MM-DD", both included. */
  firstDay: string;
  lastDay: string;
  from: Date;
  /** The end of lastDay, or the cut-off when the period is still running. */
  to: Date;
  /**
   * For a period still running, the cut-off: now, moved back by the
   * period's length. lastDay is then the cut-off's day. null for whole days.
   */
  until: Date | null;
}

/**
 * The days a period is compared with: as many days right before it, in
 * the same timezone. A period that is still running (it ends today, or
 * later) only has data up to now, so it is compared up to the same moment
 * of its earlier counterpart: now, moved back by the period's length. A
 * day in progress is never compared with a whole day. Calendar days are
 * counted by PostgreSQL, so daylight saving changes come out right.
 */
export async function previousDays(
  db: Kysely<Database>,
  firstDay: string,
  lastDay: string,
  timeZone: string,
  now: Date,
): Promise<PreviousDays> {
  const { rows } = await sql<{
    first_day: string;
    last_day: string;
    from: Date;
    to: Date;
    running: boolean;
  }>`
    with span as (
      select ${firstDay}::date - (${lastDay}::date - ${firstDay}::date + 1) as first,
             ${lastDay}::date - (${lastDay}::date - ${firstDay}::date + 1) as last,
             ${lastDay}::date - ${firstDay}::date + 1 as length,
             ${now}::timestamptz < ((${lastDay}::date + 1)::timestamp at time zone ${timeZone}) as running
    ),
    -- The cut-off in local time: now moved back by the length, on the calendar.
    cut as (
      select span.*,
             greatest(
               first::timestamp,
               (${now}::timestamptz at time zone ${timeZone}) - make_interval(days => length)
             ) as local_cut
      from span
    )
    select first::text as first_day,
           (case when running then local_cut::date else last end)::text as last_day,
           first::timestamp at time zone ${timeZone} as "from",
           case
             when running then local_cut at time zone ${timeZone}
             else (last + 1)::timestamp at time zone ${timeZone}
           end as "to",
           running
    from cut
  `.execute(db);
  const [row] = rows;
  if (row === undefined) throw new Error("previousDays returned no row");
  return {
    firstDay: row.first_day,
    lastDay: row.last_day,
    from: row.from,
    to: row.to,
    until: row.running ? row.to : null,
  };
}

const count = (value: unknown) => Number(value ?? 0);
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const average = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const text = (value: unknown) => (typeof value === "string" ? value : null);

/** "YYYY-MM-DD" a calendar day later. */
function nextDay(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

/**
 * Optional for every report: the visits the report counts, worked out
 * ahead into a temporary table of the reader's session. When it is left
 * out, each report works the visits out itself; the analytics endpoint
 * works them out once and passes them to every report (analytics.ts).
 */
export type VisitsSource =
  | {
      /** A temporary table with visitsSql's columns, in the reader's session. */
      table: string;
      /** The filters already applied to it (filterVisits). */
      filters: readonly ReportFilter[];
    }
  | undefined;

/** Filters as one comparable string, in any order. */
const filtersKey = (filters: readonly ReportFilter[] = []) =>
  filters
    .map(({ name, value }) => JSON.stringify([name, value]))
    .toSorted((a, b) => a.localeCompare(b))
    .join(",");

/** SQL for the visits a report counts: `visitsSource`, or the range's visits narrowed by its filters. */
function countedVisits(
  range: ReportRange,
  visitsSource: VisitsSource,
  params: QueryParams,
  options: VisitsQueryOptions = {},
): string {
  if (visitsSource !== undefined) {
    // Reports also narrow events by range.filters; visits filtered any other
    // way would mix filtered and unfiltered numbers on one page.
    if (filtersKey(visitsSource.filters) !== filtersKey(range.filters)) {
      throw new Error("The visits source was filtered differently from the report range");
    }
    return `SELECT * FROM ${visitsSource.table}`;
  }
  // Filters read the first-event columns (source, country …).
  return filterVisits(range, visitsSql(range, params, hasFilters(range) ? {} : options), params);
}

/**
 * Events in the range that a person caused: pageviews and custom events,
 * not engagement reports, as rows of visitor_id, name, path, and
 * occurred_at. With filters, only those within one of the counted `visits`
 * (SQL with visitsSql's columns), from its start to its end.
 */
function activity(range: ReportRange, visits: string, params: QueryParams): string {
  const filtered = hasFilters(range);
  return `
    SELECT e.visitor_id AS visitor_id, e.name AS name, e.path AS path, e.occurred_at AS occurred_at
    FROM events AS e FINAL
    ${filtered ? `INNER JOIN (${visits}) AS counted ON e.visitor_id = counted.visitor_id` : ""}
    WHERE e.project_id = ${params.add(range.projectId, "UUID")}
      AND e.environment = ${params.add(range.environment, "String")}
      AND e.occurred_at >= ${params.time(range.from)}
      AND e.occurred_at < ${params.time(rangeEnd(range))}
      AND e.visitor_id IS NOT NULL
      AND e.name != '${ENGAGEMENT}'
      ${filtered ? "AND e.occurred_at >= counted.started_at AND e.occurred_at <= counted.ended_at" : ""}`;
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

export async function summary(
  reader: Reader,
  range: ReportRange,
  visitsSource?: VisitsSource,
): Promise<Summary> {
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params, { firstEventColumns: false });
  const [row = {}] = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT v.visits AS visits, v.visit_pageviews AS visit_pageviews, v.bounces AS bounces,
            v.avg_duration_ms AS avg_duration_ms, v.avg_engaged_ms AS avg_engaged_ms,
            a.visitors AS visitors, a.pageviews AS pageviews
     FROM (SELECT count() AS visits, sum(pageviews) AS visit_pageviews, countIf(bounce) AS bounces,
                  avgOrNull(duration_ms) AS avg_duration_ms, avgOrNull(engaged_ms) AS avg_engaged_ms
           FROM (${visits})) AS v
     CROSS JOIN (SELECT uniqExact(visitor_id) AS visitors, countIf(name = '${PAGEVIEW}') AS pageviews
                 FROM (${activity(range, visits, params)})) AS a`,
    params,
  );
  const visitCount = count(row.visits);
  return {
    visitors: count(row.visitors),
    pageviews: count(row.pageviews),
    visits: visitCount,
    viewsPerVisit: ratio(count(row.visit_pageviews), visitCount),
    bounceRate: ratio(count(row.bounces), visitCount),
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
  reader: Reader,
  range: ReportRange,
  visitsSource?: VisitsSource,
): Promise<DayPoint[]> {
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params, { firstEventColumns: false });
  const timeZone = params.add(range.timeZone, "String");
  // One query, so the visits are worked out once when no source is given.
  const rows = await queryRows<{
    day: string;
    visitors: string;
    pageviews: string;
    visits: string;
  }>(
    reader,
    `SELECT day, sum(visitors) AS visitors, sum(pageviews) AS pageviews, sum(visits) AS visits
     FROM (
       SELECT toString(toDate(occurred_at, ${timeZone})) AS day, uniqExact(visitor_id) AS visitors,
              countIf(name = '${PAGEVIEW}') AS pageviews, 0 AS visits
       FROM (${activity(range, visits, params)}) GROUP BY day
       UNION ALL
       SELECT toString(toDate(started_at, ${timeZone})) AS day, 0, 0, count()
       FROM (${visits}) GROUP BY day
     )
     GROUP BY day`,
    params,
  );
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const day = dayIn(range.timeZone);
  const last = day(new Date(range.to.getTime() - 1));
  const points: DayPoint[] = [];
  for (let current = day(range.from); current <= last; current = nextDay(current)) {
    const row = byDay.get(current);
    points.push({
      day: current,
      visitors: count(row?.visitors),
      pageviews: count(row?.pageviews),
      visits: count(row?.visits),
    });
  }
  return points;
}

export interface PageRow {
  path: string;
  pageviews: number;
  visitors: number;
  /** Average time the page was visible per engagement report, or null without reports. */
  avgEngagedMs: number | null;
}

export async function topPages(
  reader: Reader,
  range: ReportRange,
  limit = DEFAULT_LIMIT,
  visitsSource?: VisitsSource,
  { offset, search }: ListOptions = {},
): Promise<PageRow[]> {
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params, { firstEventColumns: false });
  const filtered = hasFilters(range);
  const engagedMs = "JSONExtractRaw(e.properties, 'engagedMs')";
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT views.path AS path, views.pageviews AS pageviews, views.visitors AS visitors,
            engagement.avg_engaged_ms AS avg_engaged_ms
     FROM (
       SELECT path, count() AS pageviews, uniqExact(visitor_id) AS visitors
       FROM (${activity(range, visits, params)})
       WHERE name = '${PAGEVIEW}' AND ${nameContains("path", search, params)}
       GROUP BY path
     ) AS views
     LEFT JOIN (
       SELECT e.path AS path,
              avgIfOrNull(toInt64OrNull(${engagedMs}), match(${engagedMs}, '^[0-9]{1,9}$')) AS avg_engaged_ms
       FROM events AS e FINAL
       ${filtered ? `INNER JOIN (${visits}) AS counted ON e.visitor_id = counted.visitor_id` : ""}
       WHERE e.project_id = ${params.add(range.projectId, "UUID")}
         AND e.environment = ${params.add(range.environment, "String")}
         AND e.occurred_at >= ${params.time(range.from)}
         AND e.occurred_at < ${params.time(rangeEnd(range))}
         AND e.name = '${ENGAGEMENT}'
         ${
           // A report at the same moment as a visit's first pageview sorts
           // before it, so it can only be stale (visits.ts): the start is excluded.
           filtered
             ? "AND e.occurred_at > counted.started_at AND e.occurred_at <= counted.ended_at"
             : ""
         }
       GROUP BY path
     ) AS engagement USING (path)
     ORDER BY visitors DESC, pageviews DESC, path
     LIMIT ${clampLimit(limit)} OFFSET ${clampOffset(offset)}`,
    params,
  );
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
  "release",
] as const;

export type VisitDimension = (typeof VISIT_DIMENSION_NAMES)[number];

/** For names arriving from outside, such as an HTTP request. */
export function isVisitDimension(name: string): name is VisitDimension {
  return (VISIT_DIMENSION_NAMES as readonly string[]).includes(name);
}

/**
 * Each dimension maps to a fixed SQL expression over a visit row, so no
 * caller input becomes SQL. Breakdowns group by these expressions and
 * filters compare with them, so a filter matches exactly the visits its
 * breakdown row counted.
 */
const VISIT_DIMENSIONS: Record<Exclude<VisitDimension, "source">, string> = {
  entryPage: "entry_path",
  exitPage: "exit_path",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  country: "country",
  // Region and city names repeat across countries ("Springfield"), so the country is kept.
  region: "if(region IS NULL, NULL, concat(region, ', ', ifNull(country, '?')))",
  city: "if(city IS NULL, NULL, concat(city, ', ', ifNull(country, '?')))",
  deviceType: "device_type",
  browser: "browser",
  os: "os",
  release: "release",
};

/**
 * The host after "scheme://": a bracketed IPv6 address ("[2001:db8::1]")
 * whole, otherwise up to a port or path; lower case, without "www.".
 */
const REFERRER_HOST_PATTERN = String.raw`^[a-zA-Z][a-zA-Z0-9+.-]*://(\[[^\]]*\]|[^/:]+)`;

/**
 * The SQL expression of a dimension. The source of a visit is its
 * utm_source if set, otherwise the website that linked to it (without
 * "www."), otherwise "Direct / none". A referrer on one of the project's
 * own allowed hostnames is in-app navigation, not a source, so it also
 * counts as direct.
 */
function dimensionSql(dimension: VisitDimension, range: ReportRange, params: QueryParams): string {
  if (dimension !== "source") return VISIT_DIMENSIONS[dimension];
  const host = `nullIf(lower(replaceRegexpOne(extract(ifNull(referrer, ''), ${params.add(
    REFERRER_HOST_PATTERN,
    "String",
  )}), '^www\\\\.', '')), '')`;
  const own = params.add(
    range.ownHostnames.map((hostname) => hostname.toLowerCase().replace(/^www\./, "")),
    "Array(String)",
  );
  return `coalesce(utm_source, if(${host} IS NOT NULL AND NOT has(${own}, ${host}), ${host}, NULL), ${params.add(DIRECT, "String")})`;
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

/**
 * The condition one filter puts on a visit row (visitsSql's columns).
 * `allVisits` is SQL for the range's unfiltered visits, which the page
 * filter looks the page up in.
 */
function filterCondition(
  filter: ReportFilter,
  range: ReportRange,
  params: QueryParams,
  allVisits: string,
): string {
  if (filter.name === "page") {
    // Visits with a pageview of the page, between their first and last event.
    if (filter.value === null) return "0";
    // The page's views are few, so they are the joined (in-memory) side.
    return `(visitor_id, started_at) IN (
      SELECT v.visitor_id, v.started_at
      FROM (${allVisits}) AS v
      INNER JOIN (
        SELECT visitor_id, occurred_at
        FROM events FINAL
        WHERE project_id = ${params.add(range.projectId, "UUID")}
          AND environment = ${params.add(range.environment, "String")}
          AND occurred_at >= ${params.time(range.from)}
          AND occurred_at < ${params.time(rangeEnd(range))}
          AND name = '${PAGEVIEW}'
          AND path = ${params.add(filter.value, "String")}
      ) AS viewed ON viewed.visitor_id = v.visitor_id
      WHERE viewed.occurred_at >= v.started_at AND viewed.occurred_at <= v.ended_at
    )`;
  }
  // TypeScript checks callers; this guards JavaScript callers and bad input.
  if (!isVisitDimension(filter.name)) throw new Error("Unknown filter");
  const value = dimensionSql(filter.name, range, params);
  return filter.value === null
    ? `(${value}) IS NULL`
    : `(${value}) = ${params.add(filter.value, "String")}`;
}

/**
 * Only the visits (SQL with visitsSql's columns, including the first-event
 * columns) that match every filter of the range; all of them without
 * filters. The page filter reads `allVisits` (by default `visits` again).
 */
export function filterVisits(
  range: ReportRange,
  visits: string,
  params: QueryParams,
  allVisits: string = visits,
): string {
  const filters = range.filters ?? [];
  if (filters.length === 0) return visits;
  return `
    SELECT * FROM (${visits})
    WHERE ${filters.map((filter) => filterCondition(filter, range, params, allVisits)).join(" AND ")}`;
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
  reader: Reader,
  range: ReportRange,
  dimension: VisitDimension,
  limit = DEFAULT_LIMIT,
  visitsSource?: VisitsSource,
  { offset, search }: ListOptions = {},
): Promise<BreakdownRow[]> {
  // TypeScript checks callers; this guards JavaScript callers and bad input.
  if (!isVisitDimension(dimension)) throw new Error("Unknown breakdown dimension");
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params);
  const value = dimensionSql(dimension, range, params);
  const matches =
    dimension === "country" && search !== undefined && search !== ""
      ? `has(${params.add(countryCodesMatching(search), "Array(String)")}, ${value})`
      : nameContains(value, search, params);
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT ${value} AS value, uniqExact(visitor_id) AS visitors, count() AS visits,
            countIf(bounce) AS bounces
     FROM (${visits})
     WHERE ${matches}
     GROUP BY value
     ORDER BY visitors DESC, visits DESC, value ASC NULLS LAST
     LIMIT ${clampLimit(limit)} OFFSET ${clampOffset(offset)}`,
    params,
  );
  return rows.map((row) => {
    const visitCount = count(row.visits);
    return {
      value: text(row.value),
      visitors: count(row.visitors),
      visits: visitCount,
      bounceRate: ratio(count(row.bounces), visitCount),
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
  reader: Reader,
  range: ReportRange,
  limit = DEFAULT_LIMIT,
  visitsSource?: VisitsSource,
  { offset, search }: ListOptions = {},
): Promise<CustomEventRow[]> {
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params, { firstEventColumns: false });
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT name, count() AS events, uniqExact(visitor_id) AS visitors
     FROM (${activity(range, visits, params)})
     WHERE name != '${PAGEVIEW}' AND ${nameContains("name", search, params)}
     GROUP BY name
     ORDER BY visitors DESC, events DESC, name
     LIMIT ${clampLimit(limit)} OFFSET ${clampOffset(offset)}`,
    params,
  );
  return rows.map((row) => ({
    name: String(row.name),
    events: count(row.events),
    visitors: count(row.visitors),
  }));
}
