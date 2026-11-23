import type { Change } from "@/features/analytics/format";

export interface ChangeCounts {
  current: number;
  previous: number;
}

/**
 * Hide changes below the minimum: small counts exaggerate percentages
 * (docs/design-system.md, "StatStrip"). Compare the larger count to the minimum;
 * 0 shows every change. With no prior count, show "new" once the minimum is met.
 * For shares, use the counts the share is based on.
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
