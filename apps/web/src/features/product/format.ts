import { MISSING } from "@/lib/missing";
import {
  FUNNEL_COUNTS,
  FUNNEL_WINDOWS,
  type FunnelCount,
  type FunnelStep,
  type PropertyFilter,
} from "@/lib/product-api";

import { formatWhole } from "../analytics/format";
import { stepText } from "./funnel-steps";

/** Show "<1%" for positive shares that round to 0%; use the missing-value marker for no total. */
export function formatShare(part: number, whole: number): string {
  if (whole === 0) return MISSING;
  const percent = Math.round((part / whole) * 100);
  return percent === 0 && part > 0 ? "<1%" : `${percent}%`;
}

export const windowLabel = (seconds: number) =>
  FUNNEL_WINDOWS.find((item) => item.value === seconds)?.label ?? `${formatWhole(seconds)} seconds`;

/** Show empty property values as "(empty)". */
export const filterText = ({ key, value }: PropertyFilter) =>
  `${key} = ${value === "" ? "(empty)" : value}`;

export const stepsLine = (steps: readonly FunnelStep[]) => steps.map(stepText).join(" → ");

export const countLine = (count: FunnelCount, window: number) =>
  `${FUNNEL_COUNTS.find((item) => item.value === count)?.label ?? count}, within ${windowLabel(window)}`;
