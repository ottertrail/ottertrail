import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { PAGEVIEW } from "../visits/visits.ts";
import { PRODUCT_EVENT, type ProductRange, type PropertyFilter, propertyEquals } from "./events.ts";

/**
 * One ordered funnel (docs/product-analytics.md, "Funnel"): of the people
 * who did step 1 in the range, how many then did each next step, in order,
 * within the conversion window from their step 1.
 */

export type FunnelStep =
  | { type: "event"; name: string; filter?: PropertyFilter | undefined }
  | { type: "page"; path: string };

/** Who a funnel follows: a daily visitor ID, or a signed-in user's ID. */
export const FUNNEL_COUNTS = ["visitors", "users"] as const;
export type FunnelCount = (typeof FUNNEL_COUNTS)[number];

/** Conversion windows, in seconds: up to a day for visitors, whose IDs change daily. */
export const FUNNEL_WINDOWS = [300, 1800, 3600, 86_400, 604_800, 1_209_600, 2_592_000] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number];
export const MAX_VISITOR_WINDOW = 86_400;

export const MIN_STEPS = 2;
export const MAX_STEPS = 5;

/**
 * Whether one event could be both steps. ClickHouse's windowFunnel lets one
 * event count for two steps in a row when it matches both, so "/pricing,
 * then /pricing" would always convert: such steps are refused. Two event
 * steps of one name are apart only when both filter one property by
 * different values.
 */
export function stepsOverlap(first: FunnelStep, second: FunnelStep): boolean {
  if (first.type === "page" && second.type === "page") return first.path === second.path;
  if (first.type === "page" || second.type === "page") return false;
  if (first.name !== second.name) return false;
  const [a, b] = [first.filter, second.filter];
  return !(a !== undefined && b !== undefined && a.key === b.key && a.value !== b.value);
}

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

/** SQL true for an event that is this step. Values only through `params`. */
function stepSql(params: QueryParams, step: FunnelStep): string {
  if (step.type === "page") {
    return `(name = '${PAGEVIEW}' AND path = ${params.add(step.path, "String")})`;
  }
  const filter = step.filter === undefined ? "" : ` AND ${propertyEquals(params, step.filter)}`;
  return `(${PRODUCT_EVENT} AND name = ${params.add(step.name, "String")}${filter})`;
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
