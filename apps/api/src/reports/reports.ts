import { type Kysely, sql } from "kysely";

import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import { type Step, stepSql } from "../product/steps.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { channelSql } from "../visits/channel.ts";
import { COLUMN_DIMENSIONS, visitSourceKindSql, visitSourceSql } from "../visits/visit-source.ts";
import {
  ENGAGEMENT,
  analyticsEvent,
  FILE_DOWNLOAD,
  NOT_FOUND,
  OUTBOUND_LINK,
  PAGEVIEW,
  type VisitsQueryOptions,
  visitsSql,
} from "../visits/visits.ts";

/**
 * Report ranges are [from, to); localDays resolves instance-timezone
 * boundaries and chart days (docs/web-analytics.md, section 7; docs/clickhouse.md).
 */
export interface ReportRange {
  projectId: string;
  environment: string;
  from: Date;
  to: Date;
  /** IANA timezone that days are counted in, the instance's timezone. */
  timeZone: string;
  /** Treat referrers on project hostnames as direct traffic. */
  ownHostnames: readonly string[];
  /**
   * Count only matching visits and their events. Daily visitor IDs keep
   * each visit within one local day.
   */
  filters?: readonly ReportFilter[] | undefined;
  /**
   * Exclusive cutoff for partial-period comparisons, applied by rangeEnd
   * and VisitRange.until.
   */
  until?: Date | undefined;
}

const rangeEnd = ({ to, until }: ReportRange): Date =>
  until !== undefined && until < to ? until : to;

const hasFilters = (range: ReportRange) => (range.filters?.length ?? 0) > 0;

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;

const MAX_OFFSET = 100_000;

export interface ListOptions {
  offset?: number | undefined;
  search?: string | undefined;
  /** Exit pages only: add each row's exit rate, which reads the range's pageviews again. */
  exitRate?: boolean | undefined;
}

/** Match literal substrings, case-insensitive; missing search matches all. */
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

/** Search English country names while storing codes. */
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

/**
 * Resolve inclusive YYYY-MM-DD days through PostgreSQL to handle
 * 23- and 25-hour daylight saving days.
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
   * Partial-period cutoff: now shifted back by the period length; lastDay
   * is its day. Null for whole-day comparisons.
   */
  until: Date | null;
}

/**
 * Compare the preceding equal-length period in the same timezone.
 * For a running period, shift now back by its calendar length so partial
 * days compare equally. Use PostgreSQL for daylight saving boundaries.
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

function nextDay(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

/**
 * Optionally reuse visits in a temporary table in the reader session.
 * Without it, each report computes visits; analytics.ts computes them once.
 */
export type VisitsSource =
  | {
      /** A temporary table with visitsSql's columns, in the reader's session. */
      table: string;
      /** The filters already applied to it (filterVisits). */
      filters: readonly ReportFilter[];
    }
  | undefined;

const filtersKey = (filters: readonly ReportFilter[] = []) =>
  filters
    .map(({ name, operator, values }) =>
      JSON.stringify([name, operator, values.toSorted((x, y) => (x ?? "").localeCompare(y ?? ""))]),
    )
    .toSorted((a, b) => a.localeCompare(b))
    .join(",");

function countedVisits(
  range: ReportRange,
  visitsSource: VisitsSource,
  params: QueryParams,
  options: VisitsQueryOptions = {},
): string {
  if (visitsSource !== undefined) {
    // Match event and visit filters to avoid mixing inconsistent counts.
    if (filtersKey(visitsSource.filters) !== filtersKey(range.filters)) {
      throw new Error("The visits source was filtered differently from the report range");
    }
    return `SELECT * FROM ${visitsSource.table}`;
  }
  // Filters read the first-event columns (source, country …).
  return filterVisits(range, visitsSql(range, params, hasFilters(range) ? {} : options), params);
}

/**
 * The goal a report adds conversions for (docs/web-analytics.md, "The goal
 * filter"). It does not narrow the visits.
 */
export interface GoalFilter {
  step: Step;
  /** A temporary table of goalVisitsSql's rows in the reader's session; worked out when left out. */
  table?: string | undefined;
}

/**
 * The counted visits in which the goal was reached: a goal event in the
 * range, from the visit's start to its end. Matching is stepSql's, as for
 * the Goals table and funnels. `visits` has visitsSql's columns.
 */
export function goalVisitsSql(
  range: ReportRange,
  visits: string,
  step: Step,
  params: QueryParams,
): string {
  return `
    SELECT DISTINCT v.visitor_id AS visitor_id, v.started_at AS started_at, v.ended_at AS ended_at
    FROM (${visits}) AS v
    INNER JOIN (
      SELECT visitor_id, occurred_at
      FROM events FINAL
      WHERE project_id = ${params.add(range.projectId, "UUID")}
        AND environment = ${params.add(range.environment, "String")}
        AND occurred_at >= ${params.time(range.from)}
        AND occurred_at < ${params.time(rangeEnd(range))}
        AND visitor_id IS NOT NULL
        AND ${stepSql(params, step)}
    ) AS reached ON reached.visitor_id = v.visitor_id
    WHERE reached.occurred_at >= v.started_at AND reached.occurred_at <= v.ended_at`;
}

function reachedVisits(
  range: ReportRange,
  goal: GoalFilter,
  visits: string,
  params: QueryParams,
): string {
  return goal.table === undefined
    ? goalVisitsSql(range, visits, goal.step, params)
    : `SELECT visitor_id, started_at, ended_at FROM ${goal.table}`;
}

/**
 * Count pageviews and custom events within the selected visits. Exclude
 * engagement, errors, and Web Vitals. Goal matching uses properties and
 * error_fingerprint (product/steps.ts, stepSql).
 */
function activity(range: ReportRange, visits: string, params: QueryParams): string {
  const filtered = hasFilters(range);
  return `
    SELECT e.visitor_id AS visitor_id, e.name AS name, e.path AS path, e.occurred_at AS occurred_at,
           e.properties AS properties, e.error_fingerprint AS error_fingerprint
    FROM events AS e FINAL
    ${filtered ? `INNER JOIN (${visits}) AS counted ON e.visitor_id = counted.visitor_id` : ""}
    WHERE e.project_id = ${params.add(range.projectId, "UUID")}
      AND e.environment = ${params.add(range.environment, "String")}
      AND e.occurred_at >= ${params.time(range.from)}
      AND e.occurred_at < ${params.time(rangeEnd(range))}
      AND e.visitor_id IS NOT NULL
      AND e.name != '${ENGAGEMENT}'
      AND ${analyticsEvent("e")}
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

/**
 * Avoid computing visits for unfiltered counts. Used as the overview
 * goal-conversion denominator.
 */
export async function visitorCount(reader: Reader, range: ReportRange): Promise<number> {
  const params = new QueryParams();
  const visits = countedVisits(range, undefined, params, { firstEventColumns: false });
  const [row] = await queryRows<{ visitors: string }>(
    reader,
    `SELECT uniqExact(visitor_id) AS visitors FROM (${activity(range, visits, params)})`,
    params,
  );
  return count(row?.visitors);
}

export interface DayPoint {
  /** "YYYY-MM-DD" in the report's timezone. Days without data are included with zeros. */
  day: string;
  visitors: number;
  pageviews: number;
  visits: number;
  /** With a goal: the day's visitors with a goal event that day. */
  converted?: number;
}

export async function timeseries(
  reader: Reader,
  range: ReportRange,
  visitsSource?: VisitsSource,
  goal?: Step,
): Promise<DayPoint[]> {
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params, { firstEventColumns: false });
  const timeZone = params.add(range.timeZone, "String");
  const converted = goal === undefined ? "0" : `uniqExactIf(visitor_id, ${stepSql(params, goal)})`;
  // One query, so the visits are worked out once when no source is given.
  const rows = await queryRows<{
    day: string;
    visitors: string;
    pageviews: string;
    visits: string;
    converted: string;
  }>(
    reader,
    `SELECT day, sum(visitors) AS visitors, sum(pageviews) AS pageviews, sum(visits) AS visits,
            sum(converted) AS converted
     FROM (
       SELECT toString(toDate(occurred_at, ${timeZone})) AS day, uniqExact(visitor_id) AS visitors,
              countIf(name = '${PAGEVIEW}') AS pageviews, 0 AS visits, ${converted} AS converted
       FROM (${activity(range, visits, params)}) GROUP BY day
       UNION ALL
       SELECT toString(toDate(started_at, ${timeZone})) AS day, 0, 0, count(), 0
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
      ...(goal === undefined ? {} : { converted: count(row?.converted) }),
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
  /** With a goal: the page's visitors who viewed it in a visit that reached the goal. */
  converted?: number;
}

/**
 * The range's pageviews; with a goal, each with `converted`: whether its
 * visit reached the goal. Visits never overlap, so the goal visit that
 * started last at or before a pageview is its own only if it had not ended.
 */
function pageviewsSql(
  range: ReportRange,
  visits: string,
  params: QueryParams,
  search: string | undefined,
  goal: GoalFilter | undefined,
): string {
  return listedEventsSql(range, visits, params, EVENT_VALUES.page, search, goal);
}

/**
 * The range's events of one name, each with `value` (its path, or its
 * link) and its visitor; with a goal, also `converted`, as for pageviews.
 */
function listedEventsSql(
  range: ReportRange,
  visits: string,
  params: QueryParams,
  { name, value }: { name: string; value: string },
  search: string | undefined,
  goal: GoalFilter | undefined,
): string {
  const listed = `SELECT ${value} AS value, visitor_id, occurred_at
    FROM (${activity(range, visits, params)})
    WHERE name = '${name}' AND ${nameContains(value, search, params)}`;
  if (goal === undefined) return listed;
  return `
    SELECT a.value AS value, a.visitor_id AS visitor_id, reached.ended_at >= a.occurred_at AS converted
    FROM (${listed}) AS a
    ASOF LEFT JOIN (${reachedVisits(range, goal, visits, params)}) AS reached
      ON a.visitor_id = reached.visitor_id AND a.occurred_at >= reached.started_at`;
}

/** The link an outbound_link or file_download event carries (collection/links.ts). */
const LINK_URL = "JSONExtractString(properties, 'url')";

/**
 * Events that a list counts and a filter matches by one value: the
 * filter and its list read the same expression, so a row's filter keeps
 * exactly the visits that row counted. Constants only: never input.
 */
const EVENT_VALUES = {
  page: { name: PAGEVIEW, value: "path" },
  outbound: { name: OUTBOUND_LINK, value: LINK_URL },
  download: { name: FILE_DOWNLOAD, value: LINK_URL },
  notFound: { name: NOT_FOUND, value: "path" },
} as const;

/** The lists of the tracker's link and page events (docs/web-analytics.md, "Links and not found pages"). */
export const EVENT_LISTS = {
  outboundLinks: "outbound",
  fileDownloads: "download",
  notFoundPages: "notFound",
} as const satisfies Record<string, keyof typeof EVENT_VALUES>;

export type EventList = keyof typeof EVENT_LISTS;

export interface EventValueRow {
  /** The link's origin and path, or the not found page's path. */
  value: string;
  visitors: number;
  events: number;
  /** With a goal: the row's visitors who did it in a visit that reached the goal. */
  converted?: number;
}

/** One list of EVENT_LISTS, most visitors first; with a goal, most converted first. */
export async function eventValues(
  reader: Reader,
  range: ReportRange,
  list: EventList,
  limit = DEFAULT_LIMIT,
  visitsSource?: VisitsSource,
  { offset, search }: ListOptions = {},
  goal?: GoalFilter,
): Promise<EventValueRow[]> {
  const counted = EVENT_VALUES[EVENT_LISTS[list]];
  // Validate JavaScript callers and untrusted input at runtime.
  if ((counted as unknown) === undefined) throw new Error("Unknown event list");
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params, { firstEventColumns: false });
  const withGoal = goal !== undefined;
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT value, count() AS events, uniqExact(visitor_id) AS visitors
            ${withGoal ? ", uniqExactIf(visitor_id, converted) AS converted" : ""}
     FROM (${listedEventsSql(range, visits, params, counted, search, goal)})
     GROUP BY value
     ORDER BY ${withGoal ? "converted DESC," : ""} visitors DESC, events DESC, value
     LIMIT ${clampLimit(limit)} OFFSET ${clampOffset(offset)}`,
    params,
  );
  return rows.map((row) => ({
    value: String(row.value),
    visitors: count(row.visitors),
    events: count(row.events),
    ...(withGoal ? { converted: count(row.converted) } : {}),
  }));
}

export async function topPages(
  reader: Reader,
  range: ReportRange,
  limit = DEFAULT_LIMIT,
  visitsSource?: VisitsSource,
  { offset, search }: ListOptions = {},
  goal?: GoalFilter,
): Promise<PageRow[]> {
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params, { firstEventColumns: false });
  const filtered = hasFilters(range);
  const engagedMs = "JSONExtractRaw(e.properties, 'engagedMs')";
  const withGoal = goal !== undefined;
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT views.path AS path, views.pageviews AS pageviews, views.visitors AS visitors,
            ${withGoal ? "views.converted AS converted," : ""}
            engagement.avg_engaged_ms AS avg_engaged_ms
     FROM (
       SELECT value AS path, count() AS pageviews, uniqExact(visitor_id) AS visitors
              ${withGoal ? ", uniqExactIf(visitor_id, converted) AS converted" : ""}
       FROM (${pageviewsSql(range, visits, params, search, goal)})
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
           // Exclude the start: engagement at the first pageview timestamp sorts
           // before it and belongs to an earlier visit (visits.ts).
           filtered
             ? "AND e.occurred_at > counted.started_at AND e.occurred_at <= counted.ended_at"
             : ""
         }
       GROUP BY path
     ) AS engagement USING (path)
     ORDER BY ${withGoal ? "converted DESC," : ""} visitors DESC, pageviews DESC, path
     LIMIT ${clampLimit(limit)} OFFSET ${clampOffset(offset)}`,
    params,
  );
  return rows.map((row) => ({
    path: String(row.path),
    pageviews: count(row.pageviews),
    visitors: count(row.visitors),
    avgEngagedMs: average(row.avg_engaged_ms),
    ...(withGoal ? { converted: count(row.converted) } : {}),
  }));
}

export const VISIT_DIMENSION_NAMES = [
  "source",
  "sourceKind",
  "referrer",
  "channel",
  "hostname",
  "entryPage",
  "exitPage",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
  "country",
  "region",
  "city",
  "deviceType",
  "browser",
  "browserVersion",
  "os",
  "release",
] as const;

export type VisitDimension = (typeof VISIT_DIMENSION_NAMES)[number];

export function isVisitDimension(name: string): name is VisitDimension {
  return (VISIT_DIMENSION_NAMES as readonly string[]).includes(name);
}

/**
 * Use fixed SQL expressions so input cannot become SQL. Share them
 * between breakdowns and filters to keep counts consistent.
 */
const VISIT_DIMENSIONS: Record<
  Exclude<VisitDimension, "source" | "sourceKind" | "channel">,
  string
> = {
  // The stored referrer: its site and path, which browsers often cut to the site.
  referrer: "referrer",
  hostname: "hostname",
  entryPage: "entry_path",
  exitPage: "exit_path",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmTerm: "utm_term",
  utmContent: "utm_content",
  // With the browser's name, so a version row means one browser: "Chrome 142".
  browserVersion:
    "if(browser IS NULL OR browser_version IS NULL, NULL, concat(browser, ' ', browser_version))",
  ...COLUMN_DIMENSIONS,
};

/**
 * A visit's source: utm_source, then the referrer host without www., then
 * direct, with project hostnames as direct (visits/visit-source.ts). Its
 * channel groups the same columns into kinds of source (visits/channel.ts).
 */
function dimensionSql(dimension: VisitDimension, range: ReportRange, params: QueryParams): string {
  if (dimension === "source") return visitSourceSql(range.ownHostnames, params);
  if (dimension === "sourceKind") return visitSourceKindSql(range.ownHostnames, params);
  if (dimension === "channel") return channelSql(range.ownHostnames, params);
  return VISIT_DIMENSIONS[dimension];
}

/** Filters by an event of the visit (EVENT_VALUES): a page viewed, a link clicked, a not found page. */
const EVENT_FILTER_NAMES = ["page", "outbound", "download", "notFound"] as const;

type EventFilterName = (typeof EVENT_FILTER_NAMES)[number];

const isEventFilterName = (name: string): name is EventFilterName =>
  (EVENT_FILTER_NAMES as readonly string[]).includes(name);

export const FILTER_NAMES = [...EVENT_FILTER_NAMES, ...VISIT_DIMENSION_NAMES] as const;

export type FilterName = (typeof FILTER_NAMES)[number];

/** How a filter compares a visit's value with its values (docs/web-analytics.md, "Filters"). */
export const FILTER_OPERATORS = ["is", "isNot", "contains", "notContains"] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * Free text takes every operator. A fixed value (a country code, a device
 * type, a browser or system name) takes is and is not only: part of a code
 * or of a name from a short list rarely means anything.
 */
export type FilterKind = "text" | "fixed";

/** Every filter and its kind: adding a filter is one line here. */
export const FILTER_KINDS = {
  page: "text",
  outbound: "text",
  download: "text",
  notFound: "text",
  source: "text",
  sourceKind: "fixed",
  referrer: "text",
  channel: "fixed",
  hostname: "text",
  entryPage: "text",
  exitPage: "text",
  utmSource: "text",
  utmMedium: "text",
  utmCampaign: "text",
  utmTerm: "text",
  utmContent: "text",
  country: "fixed",
  region: "text",
  city: "text",
  deviceType: "fixed",
  browser: "fixed",
  browserVersion: "text",
  os: "fixed",
  release: "text",
} as const satisfies Record<FilterName, FilterKind>;

/** The operators a filter takes. */
export const operatorsOf = (name: FilterName): readonly FilterOperator[] =>
  FILTER_KINDS[name] === "text" ? FILTER_OPERATORS : ["is", "isNot"];

export interface ReportFilter {
  name: FilterName;
  operator: FilterOperator;
  /**
   * Values as their breakdown rows show them, any of which matches (OR).
   * With is and is not, null matches an unknown value. Contains reads each
   * as a literal part, ignoring case.
   */
  values: readonly (string | null)[];
}

export function isFilterName(name: string): name is FilterName {
  return (FILTER_NAMES as readonly string[]).includes(name);
}

const isNegated = (operator: FilterOperator) => operator === "isNot" || operator === "notContains";

/**
 * Whether `value` matches any of the filter's values. Never NULL, so NOT
 * keeps the visits whose value is unknown. Values are parameters, and
 * contains uses a position function, so no text is read as a pattern.
 */
function matchSql(
  value: string,
  { operator, values }: ReportFilter,
  params: QueryParams,
  { unknown }: { unknown: boolean },
): string {
  const known = values.filter((item) => item !== null);
  const parts =
    operator === "contains" || operator === "notContains"
      ? known.map(
          (part) => `positionCaseInsensitiveUTF8(${value}, ${params.add(part, "String")}) > 0`,
        )
      : [
          ...(known.length === 0 ? [] : [`(${value}) IN ${params.add(known, "Array(String)")}`]),
          ...(unknown && values.includes(null) ? [`(${value}) IS NULL`] : []),
        ];
  return parts.length === 0 ? "0" : `ifNull(${parts.join(" OR ")}, 0)`;
}

/** allVisits supplies unfiltered visits for the page filter lookup. */
function filterCondition(
  filter: ReportFilter,
  range: ReportRange,
  params: QueryParams,
  allVisits: string,
): string {
  const negated = isNegated(filter.operator);
  if (isEventFilterName(filter.name)) {
    const { name, value } = EVENT_VALUES[filter.name];
    // A stored path or link is never unknown, so an empty value matches no event.
    const match = matchSql(value, filter, params, { unknown: false });
    if (match === "0") return negated ? "1" : "0";
    // The page's views (or the link's clicks) are few, so they are the joined (in-memory) side.
    return `(visitor_id, started_at) ${negated ? "NOT IN" : "IN"} (
      SELECT v.visitor_id, v.started_at
      FROM (${allVisits}) AS v
      INNER JOIN (
        SELECT visitor_id, occurred_at
        FROM events FINAL
        WHERE project_id = ${params.add(range.projectId, "UUID")}
          AND environment = ${params.add(range.environment, "String")}
          AND occurred_at >= ${params.time(range.from)}
          AND occurred_at < ${params.time(rangeEnd(range))}
          AND name = '${name}'
          AND ${match}
      ) AS viewed ON viewed.visitor_id = v.visitor_id
      WHERE viewed.occurred_at >= v.started_at AND viewed.occurred_at <= v.ended_at
    )`;
  }
  // Validate JavaScript callers and untrusted input at runtime.
  if (!isVisitDimension(filter.name)) throw new Error("Unknown filter");
  const match = matchSql(dimensionSql(filter.name, range, params), filter, params, {
    unknown: true,
  });
  return negated ? `NOT ${match}` : match;
}

/**
 * Requires visitsSql columns, including first-event fields. Page filters
 * use allVisits, defaulting to visits.
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
  /** With a goal: the row's visitors with a visit of this value that reached the goal. */
  converted?: number;
  /**
   * Exit pages only: the row's visits (its exits) divided by the page's
   * pageviews in the same visits, as Top pages counts them; null for the
   * visits without a pageview. Only with ListOptions.exitRate (the list route).
   */
  exitRate?: number | null;
}

/**
 * An unknown value ("Unknown") comes last in its list, as on the event page
 * and in a funnel's breakdown. A visit without a campaign is "No campaign",
 * a value of its own, so it sorts by its count; so is no value of every other UTM tag.
 */
const UTM_DIMENSIONS: readonly VisitDimension[] = [
  // No referrer is a value too: how a visit came, not something unknown.
  "referrer",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
];
const unknownLast = (dimension: VisitDimension) => !UTM_DIMENSIONS.includes(dimension);

/**
 * Visits grouped by one dimension (see dimensionSql), most visitors first;
 * with a goal, most converted first; Unknown last (unknownLast).
 */
export async function breakdown(
  reader: Reader,
  range: ReportRange,
  dimension: VisitDimension,
  limit = DEFAULT_LIMIT,
  visitsSource?: VisitsSource,
  { offset, search, exitRate = false }: ListOptions = {},
  goal?: GoalFilter,
): Promise<BreakdownRow[]> {
  // Validate JavaScript callers and untrusted input at runtime.
  if (!isVisitDimension(dimension)) throw new Error("Unknown breakdown dimension");
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params);
  const value = dimensionSql(dimension, range, params);
  const matches =
    dimension === "country" && search !== undefined && search !== ""
      ? `has(${params.add(countryCodesMatching(search), "Array(String)")}, ${value})`
      : nameContains(value, search, params);
  const converted =
    goal === undefined
      ? ""
      : `, uniqExactIf(visitor_id, (visitor_id, started_at) IN (
           SELECT visitor_id, started_at FROM (${reachedVisits(range, goal, visits, params)})
         )) AS converted`;
  const order = `${unknownLast(dimension) ? "value IS NULL," : ""}
    ${goal === undefined ? "" : "converted DESC,"} visitors DESC, visits DESC, value ASC NULLS LAST`;
  const listed = `SELECT ${value} AS value, uniqExact(visitor_id) AS visitors, count() AS visits,
            countIf(bounce) AS bounces ${converted}
     FROM (${visits})
     WHERE ${matches}
     GROUP BY value
     ORDER BY ${order}
     LIMIT ${clampLimit(limit)} OFFSET ${clampOffset(offset)}`;
  const exits = exitRate && dimension === "exitPage";
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    exits
      ? // The listed pages' pageviews, as Top pages counts them, for the exit rate.
        `SELECT listed.*, views.pageviews AS pageviews
         FROM (${listed}) AS listed
         LEFT JOIN (
           SELECT path, count() AS pageviews
           FROM (${activity(range, visits, params)})
           WHERE name = '${PAGEVIEW}'
           GROUP BY path
         ) AS views ON listed.value = views.path
         ORDER BY ${order}`
      : listed,
    params,
  );
  return rows.map((row) => {
    const visitCount = count(row.visits);
    return {
      value: text(row.value),
      visitors: count(row.visitors),
      visits: visitCount,
      bounceRate: ratio(count(row.bounces), visitCount),
      ...(goal === undefined ? {} : { converted: count(row.converted) }),
      ...(exits
        ? { exitRate: row.value === null ? null : ratio(visitCount, count(row.pageviews)) }
        : {}),
    };
  });
}

export interface CustomEventRow {
  name: string;
  events: number;
  visitors: number;
}

/**
 * Custom events (everything but pageviews, engagement reports, and the
 * events of EVENT_LISTS, which have lists of their own), most visitors first.
 */
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
     WHERE name NOT IN ('${PAGEVIEW}', '${OUTBOUND_LINK}', '${FILE_DOWNLOAD}', '${NOT_FOUND}')
       AND ${nameContains("name", search, params)}
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

/** How many visitors reached a goal, and how often (goals/goals.ts). */
export interface GoalCount {
  /** Visitors with at least one: daily IDs, as the summary counts them. */
  visitors: number;
  events: number;
}

/**
 * Use the same visits and filters as the page so goal conversions stay
 * consistent. Count all goals in one query.
 */
export async function goalCounts(
  reader: Reader,
  range: ReportRange,
  steps: readonly Step[],
  visitsSource?: VisitsSource,
): Promise<GoalCount[]> {
  if (steps.length === 0) return [];
  const params = new QueryParams();
  const visits = countedVisits(range, visitsSource, params, { firstEventColumns: false });
  const source = activity(range, visits, params);
  const columns = steps
    .map((step, index) => {
      const matches = stepSql(params, step);
      return `uniqExactIf(visitor_id, ${matches}) AS visitors_${index}, countIf(${matches}) AS events_${index}`;
    })
    .join(",\n           ");
  const [row] = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT ${columns} FROM (${source})`,
    params,
  );
  return steps.map((_, index) => ({
    visitors: count(row?.[`visitors_${index}`] ?? 0),
    events: count(row?.[`events_${index}`] ?? 0),
  }));
}
