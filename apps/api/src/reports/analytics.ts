import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { QueryParams, queryRows, type Reader, runCommand } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { type Goal, listGoals } from "../goals/goals.ts";
import { analyticsEvent, visitsSql } from "../visits/visits.ts";
import {
  type BreakdownRow,
  breakdown,
  type CustomEventRow,
  customEvents,
  type DayPoint,
  DEFAULT_LIMIT,
  filterVisits,
  type GoalCount,
  goalCounts,
  localDays,
  type PreviousDays,
  previousDays,
  type PageRow,
  type ReportFilter,
  type ReportRange,
  type Summary,
  summary,
  timeseries,
  topPages,
  type VisitDimension,
  type VisitsSource,
} from "./reports.ts";

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
  "release",
] as const satisfies readonly VisitDimension[];

export type AnalyticsBreakdown = (typeof ANALYTICS_BREAKDOWNS)[number];

/** Lists support full pagination. */
export const LIST_REPORTS = ["pages", "customEvents", ...ANALYTICS_BREAKDOWNS] as const;

export type ListReport = (typeof LIST_REPORTS)[number];

/** The period before, for comparison: the same length, up to the same time of day. */
export interface PreviousPeriod extends Pick<PreviousDays, "firstDay" | "lastDay" | "until"> {
  summary: Summary;
}

export interface Analytics {
  /** The instance's timezone, which the days are counted in. */
  timeZone: string;
  environment: string;
  /**
   * Include the selected environment even without events so the page
   * can switch back.
   */
  environments: string[];
  /** First and last day of the range, "YYYY-MM-DD", both included. */
  firstDay: string;
  lastDay: string;
  summary: Summary;
  days: DayPoint[];
  pages: PageRow[];
  breakdowns: Record<AnalyticsBreakdown, BreakdownRow[]>;
  customEvents: CustomEventRow[];
  /** The project's saved goals, counted in the same visits (goals/goals.ts). */
  goals: GoalResult[];
  previous: PreviousPeriod;
}

export interface GoalResult extends Goal, GoalCount {
  /** Visitors who reached it, of all the visitors: 0 to 1; 0 without visitors. */
  conversionRate: number;
}

async function goalResults(
  reader: Reader,
  range: ReportRange,
  goals: readonly Goal[],
  visits: VisitsSource,
  visitors: number,
): Promise<GoalResult[]> {
  const counts = await goalCounts(
    reader,
    range,
    goals.map((goal) => goal.step),
    visits,
  );
  return goals.map((goal, index) => {
    const counted = counts[index] ?? { visitors: 0, events: 0 };
    return {
      ...goal,
      ...counted,
      conversionRate: visitors === 0 ? 0 : counted.visitors / visitors,
    };
  });
}

/**
 * PostgreSQL defines local day boundaries and supplies hostnames for
 * distinguishing referrals from in-app navigation.
 */
async function dayRange(
  db: Kysely<Database>,
  options: {
    projectId: string;
    environment: string;
    firstDay: string;
    lastDay: string;
    timeZone: string;
    filters: readonly ReportFilter[];
  },
): Promise<ReportRange> {
  const { projectId, environment, firstDay, lastDay, timeZone, filters } = options;
  const [days, project] = await Promise.all([
    localDays(db, firstDay, lastDay, timeZone),
    db
      .selectFrom("projects")
      .select("allowed_hostnames")
      .where("id", "=", projectId)
      .executeTakeFirst(),
  ]);
  return {
    projectId,
    environment,
    timeZone,
    filters,
    ownHostnames: project?.allowed_hostnames ?? [],
    ...days,
  };
}

/**
 * Exclude server events without visitor IDs. Include the selected
 * environment and production even without events so the page can switch back.
 */
async function environmentsIn(reader: Reader, range: ReportRange): Promise<string[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ environment: string }>(
    reader,
    `SELECT environment FROM events
     WHERE project_id = ${params.add(range.projectId, "UUID")}
       AND occurred_at >= ${params.time(range.from)}
       AND occurred_at < ${params.time(range.to)}
       AND visitor_id IS NOT NULL
       AND ${analyticsEvent()}
     GROUP BY environment
     ORDER BY count() DESC, environment`,
    params,
  );
  const names = rows.map((row) => row.environment);
  for (const name of [range.environment, DEFAULT_ENVIRONMENT]) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const VISITS_TABLE = "analytics_visits";

/**
 * Compute visits once per request because sorting events is expensive
 * (docs/web-analytics.md, section 7). Store filtered visits in a temporary
 * ClickHouse session table; run queries serially and drop it on completion.
 * ClickHouse has no snapshot across queries, so arriving events may appear
 * in only some reports.
 */
export async function projectAnalytics(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  options: {
    projectId: string;
    /** The environment to count; "production" when left out. */
    environment?: string;
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
    environment = DEFAULT_ENVIRONMENT,
    firstDay,
    lastDay,
    timeZone,
    limit = DEFAULT_LIMIT,
    filters = [],
    now = new Date(),
  } = options;
  const [range, previous, saved] = await Promise.all([
    dayRange(db, { projectId, environment, firstDay, lastDay, timeZone, filters }),
    previousDays(db, firstDay, lastDay, timeZone, now),
    listGoals(db, projectId),
  ]);
  const reader: Reader = { client: clickhouse, sessionId: randomUUID() };
  const params = new QueryParams();
  // Use disk-backed MergeTree storage for ranges with millions of visits.
  await runCommand(
    reader,
    `CREATE TEMPORARY TABLE ${VISITS_TABLE} ENGINE = MergeTree ORDER BY tuple()
     AS ${filterVisits(range, visitsSql(range, params, { firstEventColumns: "together" }), params)}`,
    params,
  );
  try {
    const visits = { table: VISITS_TABLE, filters };
    const currentSummary = await summary(reader, range, visits);
    const by = (dimension: AnalyticsBreakdown) =>
      breakdown(reader, range, dimension, limit, visits);
    // One session runs one query at a time, so the reports run one after another.
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
      release: await by("release"),
    };
    // Compare only the summary, using the previous period visits.
    const previousSummary = await summary(reader, {
      ...range,
      from: previous.from,
      to: previous.to,
      until: previous.until ?? undefined,
    });
    return {
      timeZone,
      environment,
      environments: await environmentsIn(reader, range),
      firstDay,
      lastDay,
      previous: {
        firstDay: previous.firstDay,
        lastDay: previous.lastDay,
        until: previous.until,
        summary: previousSummary,
      },
      summary: currentSummary,
      days: await timeseries(reader, range, visits),
      pages: await topPages(reader, range, limit, visits),
      breakdowns,
      customEvents: await customEvents(reader, range, limit, visits),
      goals: await goalResults(reader, range, saved, visits, currentSummary.visitors),
    };
  } finally {
    // Free the table before session expiry without hiding the report error.
    await runCommand(reader, `DROP TEMPORARY TABLE IF EXISTS ${VISITS_TABLE}`).catch(
      () => undefined,
    );
  }
}

/** Read one extra row to detect whether another page exists. */
export async function projectList(
  db: Kysely<Database>,
  clickhouse: ClickHouseClient,
  options: {
    projectId: string;
    /** The environment to count; "production" when left out. */
    environment?: string;
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
  const {
    projectId,
    environment = DEFAULT_ENVIRONMENT,
    firstDay,
    lastDay,
    timeZone,
    filters = [],
    report,
    limit,
  } = options;
  const range = await dayRange(db, {
    projectId,
    environment,
    firstDay,
    lastDay,
    timeZone,
    filters,
  });
  const reader: Reader = { client: clickhouse };
  const page = { offset: options.offset, search: options.search };
  const rows =
    report === "pages"
      ? await topPages(reader, range, limit + 1, undefined, page)
      : report === "customEvents"
        ? await customEvents(reader, range, limit + 1, undefined, page)
        : await breakdown(reader, range, report, limit + 1, undefined, page);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}
