import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { QueryParams, queryRows, type Reader, runCommand } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { type Goal, listGoals } from "../goals/goals.ts";
import type { Step } from "../product/steps.ts";
import { analyticsEvent, visitsSql } from "../visits/visits.ts";
import {
  type BreakdownRow,
  breakdown,
  type CustomEventRow,
  customEvents,
  type DayPoint,
  DEFAULT_LIMIT,
  EVENT_LISTS,
  type EventList,
  type EventValueRow,
  eventValues,
  filterVisits,
  type GoalCount,
  goalCounts,
  type GoalFilter,
  goalVisitsSql,
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

/** The lists the page's answer holds: those its cards show first. */
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

/**
 * Lists behind a tab, or shown only under a filter: the dashboard reads each
 * from the list route when its tab shows, so the page's answer stays small.
 */
export const TAB_BREAKDOWNS = [
  "sourceKind",
  "referrer",
  "channel",
  "utmSource",
  "utmMedium",
  "utmTerm",
  "utmContent",
  "hostname",
  "browserVersion",
] as const satisfies readonly VisitDimension[];

/** Lists support full pagination. */
export const LIST_REPORTS = [
  "pages",
  "customEvents",
  ...ANALYTICS_BREAKDOWNS,
  ...TAB_BREAKDOWNS,
  "outboundLinks",
  "fileDownloads",
  "notFoundPages",
] as const;

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
  /** Clicks on links to other sites, by link (docs/web-analytics.md, "Links and not found pages"). */
  outboundLinks: EventValueRow[];
  /** Clicks on files, by file. */
  fileDownloads: EventValueRow[];
  /** Views of pages the site marked as not found, by path. */
  notFoundPages: EventValueRow[];
  /** The project's saved goals, counted in the same visits (goals/goals.ts). */
  goals: GoalResult[];
  /** The goal the page is filtered by, with its counts; null without one. */
  goal: PageGoalResult | null;
  previous: PreviousPeriod;
}

export interface GoalResult extends Goal, GoalCount {
  /** Visitors who reached it, of all the visitors: 0 to 1; 0 without visitors. */
  conversionRate: number;
}

/**
 * The goal the page is filtered by: a saved goal, or a custom event by
 * name as an ad hoc goal (`id` null), matched as a goal step is.
 */
export interface PageGoal {
  id: string | null;
  name: string;
  step: Step;
}

export interface PageGoalResult extends PageGoal {
  /** Visitors who reached it: daily visitor IDs, as the Goals table counts them. */
  converted: number;
  /** Goal events. */
  events: number;
  /** converted of the summary's visitors: 0 to 1; 0 without visitors. */
  conversionRate: number;
  /** The same counts in the period before. */
  previous: { converted: number; events: number };
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
const GOAL_VISITS_TABLE = "analytics_goal_visits";

/**
 * Work out the range's filtered visits once, into a temporary table of a
 * ClickHouse session, and with a goal the visits that reached it, then run
 * `work` on them and drop the tables. The session runs one query at a time.
 */
async function withVisitTables<T>(
  base: Reader,
  range: ReportRange,
  goal: Step | undefined,
  work: (reader: Reader, visits: VisitsSource, reached: GoalFilter | undefined) => Promise<T>,
): Promise<T> {
  const reader: Reader = { ...base, sessionId: randomUUID() };
  const params = new QueryParams();
  try {
    // Use disk-backed MergeTree storage for ranges with millions of visits.
    await runCommand(
      reader,
      `CREATE TEMPORARY TABLE ${VISITS_TABLE} ENGINE = MergeTree ORDER BY tuple()
       AS ${filterVisits(range, visitsSql(range, params, { firstEventColumns: "together" }), params)}`,
      params,
    );
    if (goal !== undefined) {
      const goalParams = new QueryParams();
      await runCommand(
        reader,
        `CREATE TEMPORARY TABLE ${GOAL_VISITS_TABLE} ENGINE = MergeTree ORDER BY tuple()
         AS ${goalVisitsSql(range, `SELECT * FROM ${VISITS_TABLE}`, goal, goalParams)}`,
        goalParams,
      );
    }
    return await work(
      reader,
      { table: VISITS_TABLE, filters: range.filters ?? [] },
      goal === undefined ? undefined : { step: goal, table: GOAL_VISITS_TABLE },
    );
  } finally {
    // Free the tables before session expiry without hiding the report error. Not
    // gated: a closed request has aborted its gate.
    const dropper: Reader = { client: reader.client, sessionId: reader.sessionId };
    for (const table of [GOAL_VISITS_TABLE, VISITS_TABLE]) {
      await runCommand(dropper, `DROP TEMPORARY TABLE IF EXISTS ${table}`).catch(() => undefined);
    }
  }
}

/**
 * Compute visits once per request because sorting events is expensive
 * (docs/web-analytics.md, section 7). Store filtered visits in a temporary
 * ClickHouse session table; run queries serially and drop it on completion.
 * ClickHouse has no snapshot across queries, so arriving events may appear
 * in only some reports. A goal adds conversions without narrowing the visits.
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
    /** The goal to count conversions for. */
    goal?: PageGoal | undefined;
    /** The clock, for comparing a running period up to the same time of day. */
    now?: Date;
    /** Runs the queries, such as within the dashboard's query limit; a plain reader by default. */
    reader?: Reader;
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
    goal,
    now = new Date(),
    reader: base = { client: clickhouse },
  } = options;
  const [range, previous, saved] = await Promise.all([
    dayRange(db, { projectId, environment, firstDay, lastDay, timeZone, filters }),
    previousDays(db, firstDay, lastDay, timeZone, now),
    listGoals(db, projectId),
  ]);
  return withVisitTables(base, range, goal?.step, async (reader, visits, reached) => {
    const currentSummary = await summary(reader, range, visits);
    const by = (dimension: AnalyticsBreakdown) =>
      breakdown(reader, range, dimension, limit, visits, {}, reached);
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
    // Compare only the summary and the goal's counts, using the previous period visits.
    const before: ReportRange = {
      ...range,
      from: previous.from,
      to: previous.to,
      until: previous.until ?? undefined,
    };
    const previousSummary = await summary(reader, before);
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
      days: await timeseries(reader, range, visits, goal?.step),
      pages: await topPages(reader, range, limit, visits, {}, reached),
      breakdowns,
      customEvents: await customEvents(reader, range, limit, visits),
      outboundLinks: await eventValues(reader, range, "outboundLinks", limit, visits, {}, reached),
      fileDownloads: await eventValues(reader, range, "fileDownloads", limit, visits, {}, reached),
      notFoundPages: await eventValues(reader, range, "notFoundPages", limit, visits, {}, reached),
      goals: await goalResults(reader, range, saved, visits, currentSummary.visitors),
      goal:
        goal === undefined
          ? null
          : await pageGoalResult(reader, range, before, goal, visits, currentSummary.visitors),
    };
  });
}

async function pageGoalResult(
  reader: Reader,
  range: ReportRange,
  before: ReportRange,
  goal: PageGoal,
  visits: VisitsSource,
  visitors: number,
): Promise<PageGoalResult> {
  const [now = { visitors: 0, events: 0 }] = await goalCounts(reader, range, [goal.step], visits);
  const [then = { visitors: 0, events: 0 }] = await goalCounts(reader, before, [goal.step]);
  return {
    ...goal,
    converted: now.visitors,
    events: now.events,
    conversionRate: visitors === 0 ? 0 : now.visitors / visitors,
    previous: { converted: then.visitors, events: then.events },
  };
}

const isEventList = (report: ListReport): report is EventList => Object.hasOwn(EVENT_LISTS, report);

/**
 * Read one extra row to detect whether another page exists. With a goal,
 * the visits are worked out once in a session, as for the whole page.
 */
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
    goal?: PageGoal | undefined;
    reader?: Reader;
  },
): Promise<{
  rows: PageRow[] | BreakdownRow[] | CustomEventRow[] | EventValueRow[];
  hasMore: boolean;
}> {
  const {
    projectId,
    environment = DEFAULT_ENVIRONMENT,
    firstDay,
    lastDay,
    timeZone,
    filters = [],
    report,
    limit,
    goal,
    reader: base = { client: clickhouse },
  } = options;
  const range = await dayRange(db, {
    projectId,
    environment,
    firstDay,
    lastDay,
    timeZone,
    filters,
  });
  const page = { offset: options.offset, search: options.search };
  const list = (
    reader: Reader,
    visits: VisitsSource,
    reached: GoalFilter | undefined,
  ): Promise<PageRow[] | BreakdownRow[] | CustomEventRow[] | EventValueRow[]> =>
    report === "pages"
      ? topPages(reader, range, limit + 1, visits, page, reached)
      : report === "customEvents"
        ? customEvents(reader, range, limit + 1, visits, page)
        : isEventList(report)
          ? eventValues(reader, range, report, limit + 1, visits, page, reached)
          : breakdown(
              reader,
              range,
              report,
              limit + 1,
              visits,
              { ...page, exitRate: true },
              reached,
            );
  const rows =
    goal === undefined || report === "customEvents"
      ? await list(base, undefined, undefined)
      : await withVisitTables(base, range, goal.step, list);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}
