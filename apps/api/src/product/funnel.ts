import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import {
  type AttributionRange,
  VISIT_SOURCE_COLUMNS,
  type VisitSourceName,
  withVisitSourceSql,
} from "../visits/visit-source.ts";
import { type ProductRange, propertyText } from "./events.ts";
import { type Step, stepOf, stepSql, stepsOverlap } from "./steps.ts";

/**
 * A funnel follows people from step 1 through ordered steps within its
 * conversion window (docs/product-analytics.md, "Funnel").
 */

export type FunnelStep = Step;

/** Who a funnel follows: a daily visitor ID, or a signed-in user's ID. */
export const FUNNEL_COUNTS = ["visitors", "users"] as const;
export type FunnelCount = (typeof FUNNEL_COUNTS)[number];

/** Conversion windows, in seconds: up to a day for visitors, whose IDs change daily. */
export const FUNNEL_WINDOWS = [300, 1800, 3600, 86_400, 604_800, 1_209_600, 2_592_000] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number];
export const MAX_VISITOR_WINDOW = 86_400;

export const MIN_STEPS = 2;
export const MAX_STEPS = 8;

export function funnelStepsOf(value: unknown): FunnelStep[] | null {
  if (!Array.isArray(value) || value.length < MIN_STEPS || value.length > MAX_STEPS) {
    return null;
  }
  const steps = value.map(stepOf);
  return steps.every((step): step is FunnelStep => step !== null) ? steps : null;
}

/** The first step that could match the same event as the step before it; null when none. */
export function overlappingStep(steps: readonly FunnelStep[]): number | null {
  for (let index = 1; index < steps.length; index += 1) {
    const [before, step] = [steps[index - 1], steps[index]];
    if (before !== undefined && step !== undefined && stepsOverlap(before, step)) return index;
  }
  return null;
}

export interface Refusal {
  error: string;
  message: string;
}

export const INVALID_STEPS: Refusal = {
  error: "invalid_steps",
  message: `steps must be a JSON array of ${MIN_STEPS} to ${MAX_STEPS} steps: {"type":"event","name":…} or {"type":"page","path":"/…"}.`,
};

/**
 * Reject adjacent steps that can match one event and visitor windows
 * longer than a day, because visitor IDs change daily.
 */
export function funnelRefusal(
  steps: readonly FunnelStep[],
  count: FunnelCount,
  windowSeconds: FunnelWindow,
): Refusal | null {
  const overlap = overlappingStep(steps);
  if (overlap !== null) {
    return {
      error: "steps_overlap",
      message: `Step ${overlap + 1} could match the same event as step ${overlap}, which would count it twice. Put another step between them, or make them match different pages or property values.`,
    };
  }
  if (count === "visitors" && windowSeconds > MAX_VISITOR_WINDOW) {
    return {
      error: "invalid_window",
      message:
        "Visitors can be followed for at most one day. Their IDs change daily. Count users instead.",
    };
  }
  return null;
}

export interface FunnelStepResult {
  step: FunnelStep;
  reached: number;
}

/**
 * Read through the range end plus the window so late starts can finish.
 * Only step 1 inside the range starts a funnel. `until`, when given, ends
 * the reading earlier (previousReadEnd).
 */
export async function funnel(
  reader: Reader,
  range: ProductRange,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  windowSeconds: FunnelWindow,
  { until = readEnd(range, windowSeconds) }: { until?: Date } = {},
): Promise<FunnelStepResult[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ level: string; people: string }>(
    reader,
    `SELECT level, count() AS people
     FROM (${perPersonSql(params, { range, steps, count, windowSeconds, until })})
     WHERE level > 0
     GROUP BY level`,
    params,
  );
  const atLevel = new Map(rows.map((row) => [Number(row.level), Number(row.people)]));
  return steps.map((step, index) => ({
    step,
    reached: [...atLevel].reduce((sum, [level, people]) => (level > index ? sum + people : sum), 0),
  }));
}

/** What every funnel query reads: whom, the steps, and up to when. */
interface FunnelReading {
  range: ProductRange;
  steps: readonly FunnelStep[];
  count: FunnelCount;
  windowSeconds: FunnelWindow;
  until: Date;
}

/** The range's end plus the window, so a funnel started near the end can finish. */
const readEnd = (range: ProductRange, windowSeconds: FunnelWindow) =>
  new Date(range.to.getTime() + windowSeconds * 1000);

/**
 * One row per person who did any step: `person`, their furthest step
 * (`level`, 0 when step 1 was not in the range), and the columns `more`
 * adds, which may use each step's condition and `startsInRange` (step 1
 * inside the range). Filtered by project first, then environment and time.
 */
function perPersonSql(
  params: QueryParams,
  { range, steps, count, windowSeconds, until }: FunnelReading,
  more: (sql: { conditions: string[]; startsInRange: string }) => string[] = () => [],
): string {
  const conditions = steps.map((step) => stepSql(params, step));
  const [first = "false", ...rest] = conditions;
  const startsInRange = `(${first} AND occurred_at < ${params.time(range.to)})`;
  // The column names are constants, never input.
  const who = count === "visitors" ? "visitor_id" : "user_id";
  const extra = more({ conditions, startsInRange }).map((column) => `, ${column}`);
  return `
       SELECT ${who} AS person,
              windowFunnel(${windowSeconds * 1000})(
                toUInt64(toUnixTimestamp64Milli(occurred_at)),
                ${[startsInRange, ...rest].join(",\n                ")}
              ) AS level${extra.join("")}
       FROM events FINAL
       WHERE project_id = ${params.add(range.projectId, "UUID")}
         AND environment = ${params.add(range.environment, "String")}
         AND occurred_at >= ${params.time(range.from)}
         AND occurred_at < ${params.time(until)}
         AND ${who} IS NOT NULL
         AND (${conditions.join(" OR ")})
       GROUP BY ${who}`;
}

/**
 * What a funnel can be broken down by: columns every event has, named as
 * the Web analytics page names them, the source or campaign of step 1's
 * visit, or a property of step 1's event (docs/product-analytics.md,
 * "Breakdown"). An event's own referrer is the page before it in the
 * site, so the source is its visit's (visits/visit-source.ts).
 */
export const BREAKDOWN_COLUMNS = {
  deviceType: "device_type",
  browser: "browser",
  os: "os",
  country: "country",
  release: "release",
} as const;
export type BreakdownColumn = keyof typeof BREAKDOWN_COLUMNS;
export const BREAKDOWN_NAMES: readonly (BreakdownColumn | VisitSourceName)[] = [
  "source",
  "utmCampaign",
  "deviceType",
  "browser",
  "os",
  "country",
  "release",
];

export type Breakdown =
  | { column: BreakdownColumn }
  | { visit: VisitSourceName }
  | { property: string };

/** Values shown by name; the rest add up to Other. */
export const BREAKDOWN_VALUES = 5;

export interface BreakdownRow {
  /** A value, the rest of the values ("other"), or no value ("unknown"). */
  kind: "value" | "other" | "unknown";
  /** The value, for kind "value"; null otherwise. "" is a visit without a campaign. */
  value: string | null;
  /** People at each step, as in the funnel. */
  reached: number[];
}

const KIND_ORDER = { value: 0, other: 1, unknown: 2 } as const;

/**
 * The funnel per value of one dimension. Each person counts once, under
 * the value on their first step 1 event in the range, so the rows add up
 * to the funnel. The top BREAKDOWN_VALUES values by step 1, then Other,
 * then Unknown: at most seven rows, whatever the dimension holds.
 *
 * For the source or campaign, the value is that of the visit step 1's
 * event belongs to (visit-source.ts), worked out only for the visitors
 * who did step 1 in the range. A step 1 without a visit, such as a
 * server's event, is Unknown. `ownHostnames` are the project's, whose
 * referrers are not a source.
 */
export async function funnelBreakdown(
  reader: Reader,
  range: ProductRange,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  windowSeconds: FunnelWindow,
  by: Breakdown,
  ownHostnames: readonly string[] = [],
): Promise<BreakdownRow[]> {
  const params = new QueryParams();
  const reading = { range, steps, count, windowSeconds, until: readEnd(range, windowSeconds) };
  let perPerson: string;
  if ("visit" in by) {
    // Each person's first step 1 in the range: its visitor ID and time.
    let startsInRange = "false";
    const people = perPersonSql(params, reading, (sql) => {
      startsInRange = sql.startsInRange;
      return [
        `argMinIf(tuple(visitor_id, occurred_at), occurred_at, ${startsInRange}) AS first_start`,
      ];
    });
    const starts = `
      SELECT level, first_start.1 AS visitor_id, first_start.2 AS occurred_at
      FROM (${people})
      WHERE level > 0`;
    // Only the visits of the visitor IDs that did step 1 in the range.
    const visitors = `
      SELECT visitor_id FROM events
      WHERE project_id = ${params.add(range.projectId, "UUID")}
        AND environment = ${params.add(range.environment, "String")}
        AND occurred_at >= ${params.time(range.from)}
        AND visitor_id IS NOT NULL
        AND ${startsInRange}`;
    const attribution: AttributionRange = { ...range, ownHostnames };
    perPerson = `
      SELECT level, ${VISIT_SOURCE_COLUMNS[by.visit]} AS dimension_value
      FROM (${withVisitSourceSql(attribution, starts, visitors, params)})`;
  } else {
    // A column from the allow-list, or a property name as a parameter; "" is no value (NULL).
    const valueSql =
      "column" in by
        ? `nullIf(${BREAKDOWN_COLUMNS[by.column]}, '')`
        : `nullIf(${propertyText(params.add(by.property, "String"))}, '')`;
    // A tuple keeps a NULL value: argMin skips bare NULL arguments.
    perPerson = perPersonSql(params, reading, ({ startsInRange }) => [
      `argMinIf(tuple(${valueSql}), occurred_at, ${startsInRange}).1 AS dimension_value`,
    ]);
  }
  // Step counts are constants from the validated steps, never input.
  const reached = steps.map((_, index) => `countIf(level > ${index}) AS r${index}`);
  const sums = steps.map((_, index) => `sum(r${index}) AS r${index}`);
  const rows = await queryRows<Record<string, string>>(
    reader,
    `SELECT multiIf(dimension_value IS NULL, 'unknown', place <= ${BREAKDOWN_VALUES}, 'value', 'other') AS kind,
            if(kind = 'value', dimension_value, '') AS shown,
            ${sums.join(", ")}
     FROM (
       SELECT *,
              row_number() OVER (
                PARTITION BY dimension_value IS NULL ORDER BY r0 DESC, dimension_value ASC
              ) AS place
       FROM (
         SELECT dimension_value, ${reached.join(", ")}
         FROM (${perPerson})
         WHERE level > 0
         GROUP BY dimension_value
       )
     )
     GROUP BY kind, shown`,
    params,
  );
  return rows
    .map((row): BreakdownRow => {
      const kind = row.kind === "value" || row.kind === "other" ? row.kind : "unknown";
      return {
        kind,
        value: kind === "value" ? String(row.shown) : null,
        reached: steps.map((_, index) => Number(row[`r${index}`])),
      };
    })
    .toSorted(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (b.reached[0] ?? 0) - (a.reached[0] ?? 0) ||
        (a.value ?? "").localeCompare(b.value ?? ""),
    );
}

/** Periods longer than this many days show conversion per week rather than per day. */
export const TREND_DAILY_DAYS = 60;

export type TrendUnit = "day" | "week";

export interface TrendPoint {
  /** The day, or the Monday that starts the week, "YYYY-MM-DD" in the range's timezone. */
  day: string;
  /** People whose first step 1 in the range was on that day or in that week. */
  started: number;
  /** Of them, those who reached the last step. */
  converted: number;
}

/** Per day, or per week for periods longer than TREND_DAILY_DAYS. */
export const trendUnit = (range: { firstDay: string; lastDay: string }): TrendUnit =>
  (Date.parse(range.lastDay) - Date.parse(range.firstDay)) / 86_400_000 + 1 > TREND_DAILY_DAYS
    ? "week"
    : "day";

/**
 * The funnel's overall conversion by the day (or week) of each person's
 * first step 1 in the range, in the range's timezone: one pass, so each
 * person counts once and the points add up to the funnel. Days on which
 * nobody did step 1 have no point.
 */
export async function funnelTrend(
  reader: Reader,
  range: ProductRange,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  windowSeconds: FunnelWindow,
  unit: TrendUnit,
): Promise<TrendPoint[]> {
  const params = new QueryParams();
  const perPerson = perPersonSql(
    params,
    { range, steps, count, windowSeconds, until: readEnd(range, windowSeconds) },
    ({ startsInRange }) => [`minIf(occurred_at, ${startsInRange}) AS started_at`],
  );
  const timeZone = params.add(range.timeZone, "String");
  const day = `toDate(started_at, ${timeZone})`;
  const rows = await queryRows<{ day: string; started: string; converted: string }>(
    reader,
    `SELECT toString(${unit === "week" ? `toMonday(${day})` : day}) AS day,
            count() AS started,
            countIf(level = ${params.add(steps.length, "UInt8")}) AS converted
     FROM (${perPerson})
     WHERE level > 0
     GROUP BY day
     ORDER BY day`,
    params,
  );
  return rows.map((row) => ({
    day: row.day,
    started: Number(row.started),
    converted: Number(row.converted),
  }));
}

export interface StepTime {
  /** People the time is measured for: those who reached the step. */
  people: number;
  /** In seconds; null when nobody reached the step. */
  median: number | null;
  p75: number | null;
}

export interface FunnelTimes {
  /** From each step to the next: the first entry is step 1 to step 2. */
  between: StepTime[];
  /** From step 1 to the last step, for those who converted. */
  overall: StepTime;
}

/** A step's people and its time quantiles in milliseconds, as seconds. */
function timeOf(people: unknown, times: unknown): StepTime {
  const counted = Number(people ?? 0);
  const [median, p75] = Array.isArray(times) ? times.map(Number) : [];
  const seconds = (ms: number | undefined) =>
    counted === 0 || ms === undefined || !Number.isFinite(ms) ? null : ms / 1000;
  return { people: counted, median: seconds(median), p75: seconds(p75) };
}

/**
 * The time from each step to the next, and from step 1 to the last, for
 * the people who reached it, in one pass. windowFunnel gives only a
 * person's level, so each person's step events are folded in time order
 * the way windowFunnel follows them: a new step 1 starts a new chain, a
 * step joins the chain of the step before while within the window of its
 * step 1, and the first chain to reach the last step ends the search. A
 * step repeated within the same chain keeps its first time. Each person's
 * times come from the chain at their furthest step.
 */
export async function funnelTimes(
  reader: Reader,
  range: ProductRange,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  windowSeconds: FunnelWindow,
): Promise<FunnelTimes> {
  const params = new QueryParams();
  // Step counts and the window are validated constants, never input.
  const n = steps.length;
  const windowMs = windowSeconds * 1000;
  const perPerson = perPersonSql(
    params,
    { range, steps, count, windowSeconds, until: readEnd(range, windowSeconds) },
    ({ conditions, startsInRange }) => {
      const matched = [startsInRange, ...conditions.slice(1)].map(
        (condition, index) =>
          `(toInt64(toUnixTimestamp64Milli(occurred_at)), toUInt8(if(${condition}, ${index + 1}, 0)))`,
      );
      const entries = `arraySort(arrayFlatten(groupArray(
          arrayFilter(entry -> entry.2 > 0,
            [${matched.join(", ")}]
          )
        )))`;
      // acc[i]: the timestamps of the chain at step i, empty when there is none.
      return [
        `arrayFold((acc, entry) -> if(notEmpty(acc[${n}]), acc,
           arrayMap(i -> multiIf(
             i != entry.2, acc[i],
             i = 1, [entry.1],
             notEmpty(acc[i - 1])
               AND entry.1 <= acc[i - 1][1] + ${windowMs}
               AND (empty(acc[i]) OR acc[i][1] != acc[i - 1][1]),
             arrayPushBack(acc[i - 1], entry.1),
             acc[i]
           ), range(1, ${n + 1}))
         ), ${entries}, arrayWithConstant(${n}, CAST([], 'Array(Int64)'))) AS chains`,
      ];
    },
  );
  const between = steps.slice(1).map((_, index) => {
    const step = index + 2;
    const reached = `level >= ${step} AND length(chain) >= ${step}`;
    return `countIf(${reached}) AS people${step},
            quantilesExactInclusiveIf(0.5, 0.75)(chain[${step}] - chain[${step - 1}], ${reached}) AS times${step}`;
  });
  const converted = `level = ${n} AND length(chain) = ${n}`;
  const rows = await queryRows<Record<string, string | number[]>>(
    reader,
    `SELECT ${between.join(", ")},
            countIf(${converted}) AS people_overall,
            quantilesExactInclusiveIf(0.5, 0.75)(chain[${n}] - chain[1], ${converted}) AS times_overall
     FROM (
       SELECT level, chains[level] AS chain
       FROM (${perPerson})
       WHERE level > 0
     )`,
    params,
  );
  const row = rows[0] ?? {};
  return {
    between: steps
      .slice(1)
      .map((_, index) => timeOf(row[`people${index + 2}`], row[`times${index + 2}`])),
    overall: timeOf(row.people_overall, row.times_overall),
  };
}

/** Users listed per step; the total says how many there are in all. */
export const PEOPLE_LIMIT = 100;

export const PEOPLE_OUTCOMES = ["dropped", "converted"] as const;
export type PeopleOutcome = (typeof PEOPLE_OUTCOMES)[number];

export interface FunnelPeople {
  /** Every user whose furthest step it is. */
  total: number;
  /** Up to PEOPLE_LIMIT, most recent first. */
  users: { userId: string; reachedAt: string }[];
}

/**
 * The signed-in users whose furthest step is `step` (from 1): at the last
 * step those who converted, before it those who dropped off after it.
 * Most recent first by the last time they did that step in the reading
 * (step 1's inside the range), at most PEOPLE_LIMIT, with the total.
 */
export async function funnelPeople(
  reader: Reader,
  range: ProductRange,
  steps: readonly FunnelStep[],
  windowSeconds: FunnelWindow,
  step: number,
): Promise<FunnelPeople> {
  const params = new QueryParams();
  const index = step - 1;
  const perPerson = perPersonSql(
    params,
    { range, steps, count: "users", windowSeconds, until: readEnd(range, windowSeconds) },
    ({ conditions, startsInRange }) => [
      `maxIf(occurred_at, ${index === 0 ? startsInRange : (conditions[index] ?? "false")}) AS reached_at`,
    ],
  );
  const rows = await queryRows<{ person: string; reached_at: string; total: string }>(
    reader,
    `SELECT person, reached_at, count() OVER () AS total
     FROM (${perPerson})
     WHERE level = ${params.add(step, "UInt8")}
     ORDER BY reached_at DESC, person ASC
     LIMIT ${PEOPLE_LIMIT}`,
    params,
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    users: rows.map((row) => ({
      userId: row.person,
      reachedAt: fromClickHouseTime(row.reached_at).toISOString(),
    })),
  };
}

/**
 * Where to stop reading the period before (reports.ts, previousDays): the
 * current period's reading end, or now if that comes first, moved back by
 * the distance between the two periods' starts. Later steps of the period
 * before then count only up to the same moment as this period's can.
 * Never before the period's own end, which a daylight saving change could
 * otherwise move by an hour.
 */
export function previousReadEnd(
  range: { from: Date; to: Date },
  previous: { from: Date; to: Date },
  windowSeconds: FunnelWindow,
  now: Date,
): Date {
  const windowMs = windowSeconds * 1000;
  const currentEnd = Math.min(range.to.getTime() + windowMs, now.getTime());
  const shift = range.from.getTime() - previous.from.getTime();
  const end = Math.min(previous.to.getTime() + windowMs, currentEnd - shift);
  return new Date(Math.max(previous.to.getTime(), end));
}
