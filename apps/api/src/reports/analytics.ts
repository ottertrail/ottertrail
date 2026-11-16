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
  localDays,
  type PageRow,
  type Summary,
  summary,
  timeseries,
  topPages,
  type VisitDimension,
} from "./reports.ts";

/** The breakdowns the analytics page shows. */
export type AnalyticsBreakdown = Extract<
  VisitDimension,
  | "source"
  | "utmCampaign"
  | "entryPage"
  | "exitPage"
  | "country"
  | "region"
  | "city"
  | "deviceType"
  | "browser"
  | "os"
>;

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
 */
export async function projectAnalytics(
  db: Kysely<Database>,
  options: {
    projectId: string;
    firstDay: string;
    lastDay: string;
    timeZone: string;
    limit?: number;
  },
): Promise<Analytics> {
  const { projectId, firstDay, lastDay, timeZone, limit = DEFAULT_LIMIT } = options;
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const range = { projectId, timeZone, ...(await localDays(trx, firstDay, lastDay, timeZone)) };

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
        select ${VISIT_COLUMNS} from (${visitsQuery(range)}) as visits
      `.execute(trx);
      // A new table has no statistics; without them PostgreSQL can pick a bad plan.
      await sql`analyze analytics_visits`.execute(trx);
      const visits = sql`select * from analytics_visits`;

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
      return {
        timeZone,
        firstDay,
        lastDay,
        summary: await summary(trx, range, visits),
        days: await timeseries(trx, range, visits),
        pages: await topPages(trx, range, limit),
        breakdowns,
        customEvents: await customEvents(trx, range, limit),
      };
    });
}
