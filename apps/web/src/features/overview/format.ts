import type { OverviewPeriod } from "@/lib/overview-api";

/**
 * Below these, a percent change is left out: a few errors or page loads
 * make any percentage look large (docs/dashboard.md, "Overview").
 */
export const MIN_ERRORS_FOR_CHANGE = 10;
export const MIN_LOADS_FOR_CHANGE = 20;
/** Page loads a device needs before the speed widget rates it. */
export const MIN_LOADS_TO_RATE = 20;

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" of a moment in a timezone. */
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

/**
 * The days a period covers, ending today in the instance's timezone, and
 * as many days before it, which the widgets compare with: the same days
 * the API counts (apps/api/src/reports/routes.ts, periodDays).
 */
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

/** "the last 7 days", "today", for sentences such as "No errors in the last 7 days." */
export function periodPhrase(period: OverviewPeriod): string {
  return period === "today" ? "today" : `the last ${LENGTH[period]} days`;
}

/** "api.shop.example/health": a check's URL without its scheme. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
