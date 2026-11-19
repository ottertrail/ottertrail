import type { Change } from "@/features/analytics/format";

/** What a change from the period before rests on: how many in each period. */
export interface ChangeCounts {
  current: number;
  previous: number;
}

/**
 * Whether a change is shown, by one rule for every figure that has a
 * minimum (docs/design-system.md, "StatStrip"):
 *
 * - without a minimum (0), whenever there is a change;
 * - with one, only when the larger of the two counts reaches it: a few
 *   visits or errors make any percentage look large;
 * - when the period before had none, there is no percentage: "new" once the
 *   current count reaches the minimum, nothing below it.
 *
 * The counts are the figure's own (its visitors, its errors), or for a
 * share such as a conversion rate, the counts the share is taken of.
 */
export function shownChange(
  change: Change | null,
  counts: ChangeCounts | undefined,
  min: number,
): Change | "new" | null {
  if (min === 0) return change;
  if (counts === undefined) return null;
  if (counts.previous === 0) return counts.current >= min ? "new" : null;
  return Math.max(counts.current, counts.previous) >= min ? change : null;
}
