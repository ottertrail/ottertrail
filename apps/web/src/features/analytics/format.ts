import { MISSING } from "@/lib/missing";

const whole = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** A count: 1,284 in full, 12.9K once it reaches 10,000 (stat tiles, axis ticks). */
export function formatCount(value: number): string {
  return value < 10_000 ? whole.format(value) : compact.format(value);
}

/** A count in full, for tables and lists: 12,904. */
export function formatWhole(value: number): string {
  return whole.format(value);
}

/** An average such as views per visit, to one decimal place at most: 2, 1.5; "–" when there is no data. */
export function formatRatio(value: number | null): string {
  return value === null ? MISSING : oneDecimal.format(value);
}

export interface Change {
  direction: "up" | "down" | "same";
  /** As shown: "12%", "<1%", "6 pts" */
  text: string;
  /** As read out: "12%", "less than 1%", "6 points" */
  spoken: string;
}

/**
 * Change from the previous period in percent, rounded: for counts and
 * averages. A change too small to round to 1% is "<1%", never "no change".
 * null without a value to compare with (nothing before, or 0).
 */
export function relativeChange(current: number | null, previous: number | null): Change | null {
  if (current === null || previous === null || previous === 0) {
    return null;
  }
  if (current === previous) {
    return { direction: "same", text: "0%", spoken: "0%" };
  }
  const direction = current > previous ? "up" : "down";
  const percent = Math.abs(Math.round(((current - previous) / previous) * 100));
  if (percent === 0) {
    return { direction, text: "<1%", spoken: "less than 1%" };
  }
  const text = `${whole.format(percent)}%`;
  return { direction, text, spoken: text };
}

/**
 * Change of a share (0 to 1, such as the bounce rate) in percentage points:
 * from 24% to 30% is 6 points, where a percentage (25%) would mislead.
 * Worked out from the whole percentages shown, so the change always
 * matches them.
 */
export function pointsChange(current: number | null, previous: number | null): Change | null {
  if (current === null || previous === null) {
    return null;
  }
  const points = Math.round(current * 100) - Math.round(previous * 100);
  if (points === 0) {
    return { direction: "same", text: "0 pts", spoken: "0 points" };
  }
  const size = Math.abs(points);
  return {
    direction: points > 0 ? "up" : "down",
    text: `${size} ${size === 1 ? "pt" : "pts"}`,
    spoken: `${size} ${size === 1 ? "point" : "points"}`,
  };
}

/** "15:00" in a timezone, for a moment given as an ISO time. */
export function formatTimeOfDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(
    new Date(iso),
  );
}

/** A share from 0 to 1 as a whole percentage, or "–" when there is no data. */
export function formatPercent(value: number | null): string {
  return value === null ? MISSING : `${Math.round(value * 100)}%`;
}

/**
 * A conversion rate from 0 to 1 as a percentage: one decimal below 10%
 * (5.2%), whole from there (17%); "<0.1%" for a share too small to show.
 */
export function formatConversion(value: number): string {
  const percent = value * 100;
  if (percent === 0) return "0%";
  if (percent < 0.05) return "<0.1%";
  const tenth = Math.round(percent * 10) / 10;
  return tenth < 10 ? `${tenth.toFixed(1)}%` : `${whole.format(Math.round(percent))}%`;
}

/** 45s, 3m 12s, 1h 05m; "–" when there is no data. */
export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return MISSING;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "YYYY-MM-DD" as "16 Nov", or "Mon 16 Nov" with the weekday. Days are calendar days, so UTC. */
export function formatDay(day: string, { weekday = false } = {}): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(weekday ? { weekday: "short" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

/** A calendar day ("YYYY-MM-DD") with the given date parts. */
function formatCalendarDay(day: string, parts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { ...parts, timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/**
 * "12 to 18 Nov 2026", "28 Nov to 4 Dec 2026", or "16 Nov 2026" for one
 * day: written with "to", never a dash (docs/design-system.md#dates).
 */
export function formatDayRange(firstDay: string, lastDay: string): string {
  const format = formatCalendarDay;
  const full = { day: "numeric", month: "short", year: "numeric" } as const;
  if (firstDay === lastDay) {
    return format(lastDay, full);
  }
  if (firstDay.slice(0, 4) !== lastDay.slice(0, 4)) {
    return `${format(firstDay, full)} to ${format(lastDay, full)}`;
  }
  if (firstDay.slice(0, 7) === lastDay.slice(0, 7)) {
    return `${format(firstDay, { day: "numeric" })} to ${format(lastDay, full)}`;
  }
  return `${format(firstDay, { day: "numeric", month: "short" })} to ${format(lastDay, full)}`;
}

/** A country code as its name ("DE" becomes "Germany"); other values unchanged. */
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) {
    return code;
  }
  return regionNames.of(code) ?? code;
}

/** Axis ticks from 0 that cover `max`, about `count` of them, on 1, 2, or 5 steps. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) {
    return [0, 1];
  }
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const ticks = [0];
  while ((ticks.at(-1) ?? 0) < max) {
    ticks.push(ticks.length * Math.max(1, step));
  }
  return ticks;
}
