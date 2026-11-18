import { formatNumber } from "./metric-format";

/** Host values as the Hosts pages show them. */

const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** "22.5%", "50%"; null stays null. */
export function formatPercent(value: number | null): string | null {
  return value === null ? null : `${percent.format(value)}%`;
}

/** A load average: "0.75", "12.4"; null stays null. */
export function formatLoad(value: number | null): string | null {
  return value === null ? null : formatNumber(value);
}
