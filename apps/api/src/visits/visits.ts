import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";

/** A visit ends after this long without an event. */
export const VISIT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How far before and after a range the query reads. Visitor IDs change at
 * midnight in the instance's timezone, so every visit lies within one
 * local day, and no local day is longer than 25 hours (when clocks go back).
 * With this much on each side, the query sees every visit that touches the
 * range from its first event to its last: whether it started inside the
 * range, and its exit page, duration, and bounce, which can depend on later
 * events.
 */
export const VISIT_CONTEXT_MS = 25 * 60 * 60 * 1000;

/** Reserved event names: everything else is a custom event (an interaction). */
export const PAGEVIEW = "pageview";
export const ENGAGEMENT = "engagement";
/**
 * An error in the page (docs/errors.md): an event with this name and a
 * fingerprint. Not web analytics, so visits and reports leave it out. An
 * "error" event without a fingerprint is a custom event a site sent before
 * errors existed, and counts as one.
 */
export const ERROR = "error";
/** A page load's Web Vitals, sent once when it is first hidden (speed/speed.ts). Not web analytics. */
export const VITALS = "vitals";

/**
 * SQL true for an event web analytics counts: not an error (only errors
 * have a fingerprint) and not a page load's Web Vitals. `table` qualifies
 * the columns, such as "e".
 */
export function analyticsEvent(table?: string): string {
  const column = (name: string) => (table === undefined ? name : `${table}.${name}`);
  return `${column("error_fingerprint")} = '' AND ${column("name")} != '${VITALS}'`;
}

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
  /** The app's version, as the site named it. */
  release: string | null;
}

/**
 * The visits of one project that started in [from, to), worked out from the
 * stored events when asked. Nothing about visits is stored, so late,
 * out-of-order, and duplicate events are always accounted for, and the
 * rules below can change without migrating data.
 *
 * Rules:
 * - A visit is one visitor ID's run of events with no gap over 30 minutes.
 * - Engagement events (time on page) extend a visit but never start one.
 *   An engagement event that arrives over 30 minutes after the visitor's
 *   last event reports time for a visit that has already ended, so it is
 *   not counted, even when a new visit starts right after it. At the same
 *   moment, an engagement event comes before a pageview: it reports the
 *   time up to that moment.
 * - Visitor IDs change at midnight in the instance's timezone, so a
 *   visit that crosses midnight counts as two. Joining them would link a
 *   visitor's IDs on two days, which daily salts exist to prevent.
 * - Entry and exit pages are the first and last pageviews. Referrer,
 *   campaign, browser, location, and release come from the first event that
 *   is not an engagement event.
 * - Only events of one environment count: a developer who opens the
 *   staging site and the live one has the same visitor ID on both, and the
 *   two must not join into one visit.
 */
export interface VisitRange {
  projectId: string;
  /** "production", "staging" … (collection/environment.ts). */
  environment: string;
  from: Date;
  to: Date;
  /**
   * Ignore events from this moment on, as if they had not happened yet: to
   * see an earlier day as it stood at the same time of day as now.
   */
  until?: Date | undefined;
}

/** Columns a visit takes from its first event that is not an engagement event. */
export const FIRST_EVENT_COLUMNS = [
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
  "release",
] as const;

export interface VisitsQueryOptions {
  /**
   * Include FIRST_EVENT_COLUMNS: where the visit came from and who it was.
   * Reports that only count visits leave them out (false), so the query's
   * large sort carries less data. Two ways to work them out, which give the
   * same values:
   * - "separately" (the default): one aggregate per column. ClickHouse
   *   skips the columns a query does not read, so a breakdown pays for
   *   one or two.
   * - "together": one aggregate for all of them. For a query that reads
   *   every column, such as the analytics page's table of visits: 200,000
   *   visits took 1.3 s instead of 3.5 s.
   */
  firstEventColumns?: "separately" | "together" | false;
}

/**
 * ClickHouse SQL for the visits of a range (see VisitRange), with its values
 * added to `params`. Columns: visitor_id, started_at, ended_at, engaged_ms,
 * pageviews, interactions, entry_path, exit_path, duration_ms, bounce, and
 * the first-event columns (unless left out).
 *
 * Window functions follow each visitor's events in order: by time,
 * engagement reports before other events at the same moment, then by ID so
 * the order is always the same.
 */
export function visitsSql(
  { projectId, environment, from, to, until }: VisitRange,
  params: QueryParams,
  { firstEventColumns = "separately" }: VisitsQueryOptions = {},
): string {
  const readFrom = new Date(from.getTime() - VISIT_CONTEXT_MS);
  const contextEnd = to.getTime() + VISIT_CONTEXT_MS;
  const readTo = new Date(until === undefined ? contextEnd : Math.min(contextEnd, until.getTime()));
  const order = "occurred_at, order_rank, event_id";
  // The names are the constants above, never input.
  const eventColumns = firstEventColumns === false ? "" : `, ${FIRST_EVENT_COLUMNS.join(", ")}`;
  // The first event that is not an engagement report. A tuple keeps a
  // first event's NULL: argMin skips NULL arguments.
  const firstOf = (columns: readonly string[]) =>
    `argMinIf(tuple(${columns.join(", ")}), (occurred_at, event_id), name != '${ENGAGEMENT}')`;
  const visitColumns =
    firstEventColumns === "separately"
      ? FIRST_EVENT_COLUMNS.map((name) => `, ${firstOf([name])}.1 AS ${name}`).join("")
      : firstEventColumns === "together"
        ? `, ${firstOf(FIRST_EVENT_COLUMNS)} AS first_event`
        : "";
  const unpacked =
    firstEventColumns === "together"
      ? ` EXCEPT (first_event), ${FIRST_EVENT_COLUMNS.map((name, index) => `first_event.${index + 1} AS ${name}`).join(", ")}`
      : "";

  return `
    WITH range_events AS (
      SELECT event_id, visitor_id, name, occurred_at, path ${eventColumns},
             if(name = '${ENGAGEMENT}', 0, 1) AS order_rank,
             -- Time on page as a number. A malformed value counts as 0
             -- instead of failing the whole report.
             if(name = '${ENGAGEMENT}' AND match(JSONExtractRaw(properties, 'engagedMs'), '^[0-9]{1,9}$'),
                toInt64(JSONExtractRaw(properties, 'engagedMs')), 0) AS engaged_ms
      FROM events FINAL
      WHERE project_id = ${params.add(projectId, "UUID")}
        AND environment = ${params.add(environment, "String")}
        AND visitor_id IS NOT NULL
        AND ${analyticsEvent()}
        AND occurred_at >= ${params.time(readFrom)}
        AND occurred_at < ${params.time(readTo)}
    ),
    -- A new visit starts at a visitor's first event, or after a gap over 30 minutes.
    marked AS (
      SELECT *,
             if(dateDiff('millisecond',
                         lagInFrame(occurred_at, 1, toDateTime64(0, 3, 'UTC')) OVER (
                           PARTITION BY visitor_id ORDER BY ${order}
                           ROWS BETWEEN 1 PRECEDING AND CURRENT ROW),
                         occurred_at) > ${VISIT_TIMEOUT_MS}, 1, 0) AS starts_visit
      FROM range_events
    ),
    -- A running count of visit starts numbers each visitor's visits: 1, 2, 3 …
    -- An engagement event is stale when the visitor has had no other event
    -- since the current run started: the visit it reports on has ended.
    -- (maxIf over no rows gives 1970, earlier than any start: stale.)
    numbered AS (
      SELECT *,
             sum(starts_visit) OVER so_far AS visit_number,
             name = '${ENGAGEMENT}'
               AND (maxIf(occurred_at, name != '${ENGAGEMENT}') OVER so_far
                    < maxIf(occurred_at, starts_visit = 1) OVER so_far) AS stale
      FROM marked
      WINDOW so_far AS (PARTITION BY visitor_id ORDER BY ${order}
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    visits AS (
      SELECT visitor_id,
             minIf(occurred_at, name != '${ENGAGEMENT}') AS started_at,
             max(occurred_at) AS ended_at,
             sumIf(engaged_ms, NOT stale) AS engaged_ms,
             countIf(name = '${PAGEVIEW}') AS pageviews,
             countIf(name NOT IN ('${PAGEVIEW}', '${ENGAGEMENT}')) AS interactions,
             if(pageviews = 0, NULL,
                argMinIf(path, (occurred_at, event_id), name = '${PAGEVIEW}')) AS entry_path,
             if(pageviews = 0, NULL,
                argMaxIf(path, (occurred_at, event_id), name = '${PAGEVIEW}')) AS exit_path
             ${visitColumns}
      FROM numbered
      GROUP BY visitor_id, visit_number
      HAVING countIf(name != '${ENGAGEMENT}') > 0
    )
    SELECT *${unpacked},
           dateDiff('millisecond', started_at, ended_at) AS duration_ms,
           pageviews <= 1 AND interactions = 0 AS bounce
    FROM visits
    WHERE started_at >= ${params.time(from)} AND started_at < ${params.time(to)}`;
}

/** A visit row as ClickHouse returns it: 64-bit numbers and times as strings. */
interface VisitRow {
  visitor_id: string;
  started_at: string;
  ended_at: string;
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
  release: string | null;
}

/** The visits as objects, oldest first. Reports aggregate visitsSql in ClickHouse instead. */
export async function findVisits(reader: Reader, range: VisitRange): Promise<Visit[]> {
  const params = new QueryParams();
  const rows = await queryRows<VisitRow>(
    reader,
    `SELECT * FROM (${visitsSql(range, params, { firstEventColumns: "together" })})
     ORDER BY started_at, visitor_id`,
    params,
  );
  return rows.map((row) => {
    const startedAt = fromClickHouseTime(row.started_at);
    const endedAt = fromClickHouseTime(row.ended_at);
    const pageviews = Number(row.pageviews);
    const interactions = Number(row.interactions);
    return {
      visitorId: row.visitor_id,
      startedAt,
      endedAt,
      durationMs: endedAt.getTime() - startedAt.getTime(),
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
      release: row.release,
    };
  });
}
