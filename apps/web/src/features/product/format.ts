import { FUNNEL_WINDOWS, type PropertyFilter } from "@/lib/product-api";

import { formatWhole } from "../analytics/format";

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
