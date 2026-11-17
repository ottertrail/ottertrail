import {
  FUNNEL_COUNTS,
  FUNNEL_WINDOWS,
  type FunnelCount,
  type FunnelStep,
  type PropertyFilter,
} from "@/lib/product-api";

import { formatWhole } from "../analytics/format";
import { stepText } from "./funnel-steps";

/** A share as a whole percentage; "<1%" when above 0 but too small to round to 1%; "–" of nothing. */
export function formatShare(part: number, whole: number): string {
  if (whole === 0) return "–";
  const percent = Math.round((part / whole) * 100);
  return percent === 0 && part > 0 ? "<1%" : `${percent}%`;
}

/** A conversion window in seconds as its label: "1 hour", "7 days". */
export const windowLabel = (seconds: number) =>
  FUNNEL_WINDOWS.find((item) => item.value === seconds)?.label ?? `${formatWhole(seconds)} seconds`;

/** "plan = team"; an empty string shows as "(empty)". */
export const filterText = ({ key, value }: PropertyFilter) =>
  `${key} = ${value === "" ? "(empty)" : value}`;

/** A funnel's steps on one line: "/pricing → signup → purchase". */
export const stepsLine = (steps: readonly FunnelStep[]) => steps.map(stepText).join(" → ");

/** Who a funnel counts, and for how long: "Visitors, within 1 day". */
export const countLine = (count: FunnelCount, window: number) =>
  `${FUNNEL_COUNTS.find((item) => item.value === count)?.label ?? count}, within ${windowLabel(window)}`;
