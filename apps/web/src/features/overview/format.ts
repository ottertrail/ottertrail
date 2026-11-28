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

const LENGTH: Record<Exclude<OverviewPeriod, "mtd">, number> = {
  today: 1,
  yesterday: 1,
  "7d": 7,
  "30d": 30,
};

/** The same day a month before, or that month's last when it is shorter. */
function monthBefore(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const last = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 2, Math.min(date, last))).toISOString().slice(0, 10);
}

/** Match API periods (apps/api/src/reports/routes.ts, periodDays), including the comparison period. */
export function periodDays(period: OverviewPeriod, timeZone: string, now = new Date()) {
  const today = dayIn(timeZone, now);
  if (period === "mtd") {
    const firstDay = `${today.slice(0, 8)}01`;
    return {
      firstDay,
      lastDay: today,
      previous: { firstDay: monthBefore(firstDay), lastDay: monthBefore(today) },
    };
  }
  const lastDay = period === "yesterday" ? shift(today, -1) : today;
  const length = LENGTH[period];
  const firstDay = shift(lastDay, 1 - length);
  return {
    firstDay,
    lastDay,
    previous: { firstDay: shift(firstDay, -length), lastDay: shift(firstDay, -1) },
  };
}

const PHRASES: Record<OverviewPeriod, string> = {
  today: "today",
  yesterday: "yesterday",
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  mtd: "this month",
};

/** The period as it ends a sentence: "No visits today.", "No visits in the last 7 days." */
export const periodPhrase = (period: OverviewPeriod): string => PHRASES[period];

const LABELS: Record<OverviewPeriod, string> = {
  today: "today",
  yesterday: "yesterday",
  "7d": "7 days",
  "30d": "30 days",
  mtd: "month to date",
};

/** The period after a figure's name: "Uptime, 7 days". */
export const periodLabel = (period: OverviewPeriod): string => LABELS[period];

/** A check's URL without its scheme, or "Heartbeat" for a check without one. */
export function shortUrl(url: string | null): string {
  if (url === null) return "Heartbeat";
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
