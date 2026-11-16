import { type Kysely, sql } from "kysely";

import type { Database } from "../db/schema.ts";
import { visitsQuery } from "../visits/visits.ts";
import {
  type BreakdownRow,
  breakdown,
  type CustomEventRow,
  customEvents,
  type DayPoint,
  DEFAULT_LIMIT,
  filterVisits,
  localDays,
  type PreviousDays,
  previousDays,
  type PageRow,
  type ReportFilter,
  type Summary,
  summary,
  timeseries,
  topPages,
  type VisitDimension,
} from "./reports.ts";

/** The breakdowns the analytics page shows. */
export const ANALYTICS_BREAKDOWNS = [
  "source",
  "utmCampaign",
  "entryPage",
  "exitPage",
  "country",
  "region",
  "city",
  "deviceType",
  "browser",
  "os",
] as const satisfies readonly VisitDimension[];

export type AnalyticsBreakdown = (typeof ANALYTICS_BREAKDOWNS)[number];

/** Every list of the analytics page, each of which can be read in full, a page at a time. */
export const LIST_REPORTS = ["pages", "customEvents", ...ANALYTICS_BREAKDOWNS] as const;

export type ListReport = (typeof LIST_REPORTS)[number];

/** The period before, for comparison: the same length, up to the same time of day. */
export interface PreviousPeriod extends Pick<PreviousDays, "firstDay" | "lastDay" | "until"> {
  summary: Summary;
}

export interface Analytics {
  /** The instance's timezone, which the days are counted in. */
  timeZone: string;
  /** First and last day of the range, "YYYY-MM-DD", both included. */
  firstDay: string;
  lastDay: string;
  summary: Summary;
  days: DayPoint[];
  pages: PageRow[];
  breakdowns: Record<AnalyticsBreakdown, BreakdownRow[]>;
  customEvents: CustomEventRow[];
  previous: PreviousPeriod;
}

/** Columns of visitsQuery with first-event columns, in its order. */
const VISIT_COLUMNS = sql`
  visitor_id, started_at, ended_at, engaged_ms, pageviews, interactions, entry_path, exit_path,
  referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
  browser, os, device_type, country, region, city, duration_ms, bounce
`;

/**
 * Every report the analytics page shows, for one project and a range of
 * days in the instance's timezone.
 *
 * Working out visits sorts every event in the range, and most reports need
 * them (docs/web-analytics.md, section 7). Here they are worked out once,
 * into a temporary table that lasts until the transaction ends, and every
 * report reads that table. The transaction also gives every report the same
 * snapshot of the data (REPEATABLE READ), so the numbers agree with each
 * other even while new events arrive.
 *
 * With filters, the table holds only the matching visits, and every report
 * counts those visits and their events.
 */
export async function projectAnalytics(
  db: Kysely<Database>,
  options: {
    projectId: string;
    firstDay: string;
    lastDay: string;
    timeZone: string;
    limit?: number;
    filters?: readonly ReportFilter[];
    /** The clock, for comparing a running period up to the same time of day. */
    now?: Date;
  },
): Promise<Analytics> {
  const {
    projectId,
    firstDay,
    lastDay,
    timeZone,
    limit = DEFAULT_LIMIT,
    filters = [],
    now = new Date(),
  } = options;
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const range = {
        projectId,
        timeZone,
        filters,
        ...(await localDays(trx, firstDay, lastDay, timeZone)),
      };

      // PostgreSQL cannot take query parameters in CREATE TABLE … AS, so
      // the table is declared first, then filled.
      await sql`
        create temporary table analytics_visits (
          visitor_id bigint, started_at timestamptz, ended_at timestamptz, engaged_ms numeric,
          pageviews bigint, interactions bigint, entry_path text, exit_path text,
          referrer text, utm_source text, utm_medium text, utm_campaign text, utm_term text,
          utm_content text, browser text, os text, device_type text, country text, region text,
          city text, duration_ms numeric, bounce boolean
        ) on commit drop
      `.execute(trx);
      await sql`
        insert into analytics_visits (${VISIT_COLUMNS})
        select ${VISIT_COLUMNS} from (${filterVisits(range, visitsQuery(range))}) as visits
      `.execute(trx);
      // A new table has no statistics; without them PostgreSQL can pick a bad plan.
      await sql`analyze analytics_visits`.execute(trx);
      const visits = { sql: sql`select * from analytics_visits`, filters };

      const by = (dimension: AnalyticsBreakdown) => breakdown(trx, range, dimension, limit, visits);
      // One connection runs the transaction, so the queries run one after another.
      const breakdowns: Record<AnalyticsBreakdown, BreakdownRow[]> = {
        source: await by("source"),
        utmCampaign: await by("utmCampaign"),
        entryPage: await by("entryPage"),
        exitPage: await by("exitPage"),
        country: await by("country"),
        region: await by("region"),
        city: await by("city"),
        deviceType: await by("deviceType"),
        browser: await by("browser"),
        os: await by("os"),
      };
      // The period before: its own visits, so only the summary is compared.
      const previous = await previousDays(trx, firstDay, lastDay, timeZone, now);
      const previousSummary = await summary(trx, {
        projectId,
        timeZone,
        filters,
        from: previous.from,
        to: previous.to,
        until: previous.until ?? undefined,
      });
      return {
        timeZone,
        firstDay,
        lastDay,
        previous: {
          firstDay: previous.firstDay,
          lastDay: previous.lastDay,
          until: previous.until,
          summary: previousSummary,
        },
        summary: await summary(trx, range, visits),
        days: await timeseries(trx, range, visits),
        pages: await topPages(trx, range, limit, visits),
        breakdowns,
        customEvents: await customEvents(trx, range, limit, visits),
      };
    });
}

/**
 * One list of the analytics page, a page at a time, for "show all": the
 * rows after `offset`, optionally only those whose name contains `search`,
 * and whether more follow. One row more than asked for is read to tell.
 */
export async function projectList(
  db: Kysely<Database>,
  options: {
    projectId: string;
    firstDay: string;
    lastDay: string;
    timeZone: string;
    filters?: readonly ReportFilter[];
    report: ListReport;
    limit: number;
    offset?: number;
    search?: string;
  },
): Promise<{ rows: PageRow[] | BreakdownRow[] | CustomEventRow[]; hasMore: boolean }> {
  const { projectId, firstDay, lastDay, timeZone, filters = [], report, limit } = options;
  const range = {
    projectId,
    timeZone,
    filters,
    ...(await localDays(db, firstDay, lastDay, timeZone)),
  };
  const page = { offset: options.offset, search: options.search };
  const rows =
    report === "pages"
      ? await topPages(db, range, limit + 1, undefined, page)
      : report === "customEvents"
        ? await customEvents(db, range, limit + 1, undefined, page)
        : await breakdown(db, range, report, limit + 1, undefined, page);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}
