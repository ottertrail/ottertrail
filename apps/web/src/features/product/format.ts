import { MISSING } from "@/lib/missing";
import {
  FUNNEL_COUNTS,
  FUNNEL_WINDOWS,
  type FunnelCount,
  type FunnelStep,
  type PeriodBefore,
  type PropertyFilter,
} from "@/lib/product-api";

import { formatDay, formatDayRange, formatTimeOfDay, formatWhole } from "../analytics/format";
import { stepText } from "./funnel-steps";

/** Which period the changes compare with, worded as the funnel and the Web analytics summary word it. */
export function comparedWith(previous: PeriodBefore, timeZone: string): string {
  const days = formatDayRange(previous.firstDay, previous.lastDay);
  if (previous.until === null) return `Changes compare with ${days}.`;
  const time = formatTimeOfDay(previous.until, timeZone);
  return previous.firstDay === previous.lastDay
    ? `Changes compare with ${days}, up to ${time}.`
    : `Changes compare with ${days}, up to ${time} on ${formatDay(previous.lastDay)}.`;
}

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

/** Seconds written plainly: "45 s", "4 min", "2 h 10 min", "1 day 3 h", "3 days". */
export function formatWait(seconds: number | null): string {
  if (seconds === null) return MISSING;
  if (seconds < 59.5) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  const dayText = `${days} ${days === 1 ? "day" : "days"}`;
  // Hours matter only in the first days.
  return days < 3 && hours % 24 !== 0 ? `${dayText} ${hours % 24} h` : dayText;
}
