import type { OverviewPeriod } from "@/lib/overview-api";

/** Small counts make percentage changes misleading (docs/dashboard.md, "Overview"). */
export const MIN_ERRORS_FOR_CHANGE = 10;
export const MIN_LOADS_FOR_CHANGE = 20;
export const MIN_LOADS_TO_RATE = 20;

const DAY_MS = 86_400_000;

export function dayIn(timeZone: string, moment: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const shift = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const LENGTH: Record<OverviewPeriod, number> = { today: 1, "7d": 7, "30d": 30 };

/** Match API periods (apps/api/src/reports/routes.ts, periodDays), including the comparison period. */
export function periodDays(period: OverviewPeriod, timeZone: string, now = new Date()) {
  const lastDay = dayIn(timeZone, now);
  const length = LENGTH[period];
  const firstDay = shift(lastDay, 1 - length);
  return {
    firstDay,
    lastDay,
    previous: { firstDay: shift(firstDay, -length), lastDay: shift(firstDay, -1) },
  };
}

export function periodPhrase(period: OverviewPeriod): string {
  return period === "today" ? "today" : `the last ${LENGTH[period]} days`;
}

/** A check's URL without its scheme, or "Heartbeat" for a check without one. */
export function shortUrl(url: string | null): string {
  if (url === null) return "Heartbeat";
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
