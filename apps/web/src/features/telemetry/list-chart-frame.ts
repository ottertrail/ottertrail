import type { PageRange } from "@/lib/analytics-api";

import { bucketLabel } from "./chart-time";

/** The Logs and Traces charts' time buckets, and the days a bucket narrows the period to. */

/** The time buckets a list's chart has, as the API gives them. */
export interface ListChartFrame {
  /** Each bucket's start, ISO, on the clock of the instance's timezone. */
  bucketStarts: string[];
  /** The buckets' length on the clock; one across a daylight saving change is an hour longer or shorter. */
  stepSeconds: number;
  timeZone: string;
  firstDay: string;
  lastDay: string;
}

const DAY_SECONDS = 86_400;

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD": a moment's day in the timezone set in Settings. */
function dayIn(date: Date, timeZone: string): string {
  let format = DAY_FORMATS.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    DAY_FORMATS.set(timeZone, format);
  }
  return format.format(date);
}

/** "YYYY-MM-DD" plus `days`, on the calendar. */
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** A bucket's start, as a Date. */
export const bucketStart = (frame: ListChartFrame, index: number) =>
  new Date(frame.bucketStarts[index] ?? frame.bucketStarts[0] ?? 0);

/**
 * "Tue 17 Nov 2026, 10:00 to 12:00", or the day for a bucket of days: a
 * bucket's span on the clock, its end the next bucket's start, so a
 * bucket across a daylight saving change says how long it really is.
 */
export function listBucketLabel(frame: ListChartFrame, index: number): string {
  const start = bucketStart(frame, index);
  if (frame.stepSeconds >= DAY_SECONDS)
    return bucketLabel(start, frame.stepSeconds, frame.timeZone);
  const next = frame.bucketStarts[index + 1];
  const seconds =
    next === undefined ? frame.stepSeconds : (Date.parse(next) - start.getTime()) / 1000;
  return bucketLabel(start, seconds, frame.timeZone);
}

/**
 * The days a bucket covers, as a custom range: the day its start falls on,
 * plus its step in days for a bucket of days, never past the period's.
 * Calendar days, not the bucket's end less a moment, so a bucket an hour
 * longer or shorter across a daylight saving change still gives one day.
 * Undefined when the period is one day already, so there is nothing to
 * narrow.
 */
export function bucketRange(frame: ListChartFrame, index: number): PageRange | undefined {
  if (frame.firstDay === frame.lastDay) return undefined;
  const first = dayIn(bucketStart(frame, index), frame.timeZone);
  const days = Math.max(1, Math.round(frame.stepSeconds / DAY_SECONDS));
  const last = addDays(first, days - 1);
  const from = first < frame.firstDay ? frame.firstDay : first;
  const to = last > frame.lastDay ? frame.lastDay : last;
  return { from, to };
}

/** What choosing a bar does, for its readout. */
export const selectHint = (frame: ListChartFrame) =>
  frame.stepSeconds > DAY_SECONDS ? "Click to show these days" : "Click to show this day";
