/**
 * Times on the user pages, in the organization's timezone (the API sends it
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
