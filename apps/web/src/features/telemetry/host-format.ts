import { formatNumber } from "./metric-format";

const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatPercent(value: number | null): string | null {
  return value === null ? null : `${percent.format(value)}%`;
}

export function formatLoad(value: number | null): string | null {
  return value === null ? null : formatNumber(value);
}
