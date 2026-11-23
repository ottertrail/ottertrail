import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import type { ProductRange } from "./events.ts";
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
export const MAX_STEPS = 5;

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
      message: `Step ${overlap + 1} could match the same event as step ${overlap}, which would count it twice. Put another step between them, or filter both by different values of one property.`,
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
 * Only step 1 inside the range starts a funnel.
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
  return steps.map((step, index) => ({
    step,
    reached: [...atLevel].reduce((sum, [level, people]) => (level > index ? sum + people : sum), 0),
  }));
}
