/**
 * Times on the user pages, in the timezone set in Settings (the API sends it
 * with every page), written as the rest of the dashboard writes them.
 */
export { timeAgo } from "../projects/format";

function format(iso: string, timeZone: string | undefined, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(new Date(iso));
}

/** "16 Nov 2026" */
export const formatDay = (iso: string, timeZone: string | undefined) =>
  format(iso, timeZone, { day: "numeric", month: "short", year: "numeric" });

/** "16 Nov 2026, 10:05" */
export const formatMoment = (iso: string, timeZone: string | undefined) =>
  format(iso, timeZone, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** "10:05" */
export const formatTime = (iso: string, timeZone: string | undefined) =>
  format(iso, timeZone, { hour: "2-digit", minute: "2-digit" });

/** "Monday, 16 November 2026": a day's heading in an activity list. */
export const formatLongDay = (iso: string, timeZone: string | undefined) =>
  format(iso, timeZone, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** The local day an event happened on, to group a list by: "2026-11-16". */
export const dayKey = (iso: string, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));

/** Days back each period reaches, besides today, shortest first. */
const PERIOD_REACH = [
  ["today", 0],
  ["7d", 6],
  ["30d", 29],
  ["90d", 89],
  ["12m", 364],
] as const;

/**
 * The shortest period, ending today, that covers an occurrence on `day`, so
 * the error's page shows it; past a year, the year from that day.
 */
export function rangeCovering(
  day: string,
  today: string,
): { period: (typeof PERIOD_REACH)[number][0] } | { from: string; to: string } {
  const daysAgo = Math.round((Date.parse(today) - Date.parse(day)) / 86_400_000);
  const fits = PERIOD_REACH.find(([, reach]) => daysAgo <= reach);
  if (fits !== undefined) return { period: fits[0] };
  const to = new Date(Date.parse(day) + 364 * 86_400_000).toISOString().slice(0, 10);
  return { from: day, to };
}
