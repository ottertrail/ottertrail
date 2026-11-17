import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import type { ProductRange } from "./events.ts";
import { type Step, stepSql, stepsOverlap } from "./steps.ts";

/**
 * One ordered funnel (docs/product-analytics.md, "Funnel"): of the people
 * who did step 1 in the range, how many then did each next step, in order,
 * within the conversion window from their step 1.
 */

/** A funnel's step: a page or a product event (steps.ts). */
export type FunnelStep = Step;

/** Who a funnel follows: a daily visitor ID, or a signed-in user's ID. */
export const FUNNEL_COUNTS = ["visitors", "users"] as const;
export type FunnelCount = (typeof FUNNEL_COUNTS)[number];

/** Conversion windows, in seconds: up to a day for visitors, whose IDs change daily. */
export const FUNNEL_WINDOWS = [300, 1800, 3600, 86_400, 604_800, 1_209_600, 2_592_000] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number];
export const MAX_VISITOR_WINDOW = 86_400;

export const MIN_STEPS = 2;
export const MAX_STEPS = 5;

/** The first step that could match the same event as the step before it; null when none. */
export function overlappingStep(steps: readonly FunnelStep[]): number | null {
  for (let index = 1; index < steps.length; index += 1) {
    const [before, step] = [steps[index - 1], steps[index]];
    if (before !== undefined && step !== undefined && stepsOverlap(before, step)) return index;
  }
  return null;
}

export interface FunnelStepResult {
  step: FunnelStep;
  /** People who reached this step, in order, within the window. */
  reached: number;
}

/**
 * The funnel: people reaching each step. Events are read from the range's
 * start to its end plus the window, so a funnel started near the end can
 * finish; only a step 1 inside the range starts one.
 */
export async function funnel(
  reader: Reader,
  range: ProductRange,
  steps: readonly FunnelStep[],
  count: FunnelCount,
  windowSeconds: FunnelWindow,
): Promise<FunnelStepResult[]> {
  const params = new QueryParams();
  const until = new Date(range.to.getTime() + windowSeconds * 1000);
  const conditions = steps.map((step) => stepSql(params, step));
  // Step 1 counts only inside the range.
  const [first = "false", ...rest] = conditions;
  const startsInRange = `(${first} AND occurred_at < ${params.time(range.to)})`;
  // The column names are constants, never input.
  const who = count === "visitors" ? "visitor_id" : "user_id";
  const rows = await queryRows<{ level: string; people: string }>(
    reader,
    `SELECT level, count() AS people
     FROM (
       SELECT ${who},
              windowFunnel(${windowSeconds * 1000})(
                toUInt64(toUnixTimestamp64Milli(occurred_at)),
                ${[startsInRange, ...rest].join(",\n                ")}
              ) AS level
       FROM events FINAL
       WHERE project_id = ${params.add(range.projectId, "UUID")}
         AND environment = ${params.add(range.environment, "String")}
         AND occurred_at >= ${params.time(range.from)}
         AND occurred_at < ${params.time(until)}
         AND ${who} IS NOT NULL
         AND (${conditions.join(" OR ")})
       GROUP BY ${who}
     )
     WHERE level > 0
     GROUP BY level`,
    params,
  );
  const atLevel = new Map(rows.map((row) => [Number(row.level), Number(row.people)]));
  // Reaching step k means reaching at least level k.
  return steps.map((step, index) => ({
    step,
    reached: [...atLevel].reduce((sum, [level, people]) => (level > index ? sum + people : sum), 0),
  }));
}
