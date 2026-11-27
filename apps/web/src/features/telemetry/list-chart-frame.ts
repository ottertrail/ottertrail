import type { PageRange } from "@/lib/analytics-api";

import { bucketLabel } from "./chart-time";

export interface ListChartFrame {
  /** ISO starts follow the instance timezone. */
  bucketStarts: string[];
  /** Clock-based bucket length; daylight saving changes can add or remove an hour. */
  stepSeconds: number;
  timeZone: string;
  firstDay: string;
  lastDay: string;
}

const DAY_SECONDS = 86_400;

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

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

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const bucketStart = (frame: ListChartFrame, index: number) =>
  new Date(frame.bucketStarts[index] ?? frame.bucketStarts[0] ?? 0);

/** End at the next bucket's start so daylight saving changes show the actual span. */
export function listBucketLabel(frame: ListChartFrame, index: number): string {
  const start = bucketStart(frame, index);
  if (frame.stepSeconds >= DAY_SECONDS)
    return bucketLabel(start, frame.stepSeconds, frame.timeZone);
  const next = frame.bucketStarts[index + 1];
  const seconds =
    next === undefined ? frame.stepSeconds : (Date.parse(next) - start.getTime()) / 1000;
  return bucketLabel(start, seconds, frame.timeZone);
}

/** Use calendar days so daylight saving changes still select one day. Clamp to the period; return undefined if it is already one day. */
export function bucketRange(frame: ListChartFrame, index: number): PageRange | undefined {
  if (frame.firstDay === frame.lastDay) return undefined;
  const first = dayIn(bucketStart(frame, index), frame.timeZone);
  const days = Math.max(1, Math.round(frame.stepSeconds / DAY_SECONDS));
  const last = addDays(first, days - 1);
  const from = first < frame.firstDay ? frame.firstDay : first;
  const to = last > frame.lastDay ? frame.lastDay : last;
  return { from, to };
}

/** What choosing a bar does. A finger's first tap shows the bar's numbers, so it takes another. */
export const selectHint = (frame: ListChartFrame, touch = false) =>
  `${touch ? "Tap again" : "Click"} to show ${frame.stepSeconds > DAY_SECONDS ? "these days" : "this day"}`;
